import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS_STORAGE_KEY,
  createAttempt,
  getActiveAttempt,
  updateAttempt,
} from "./attemptStore.js";

// Fixtures: public payment data only. The issuer and source tag are chain
// constants from the README; payer and destination are synthetic mainnet-format
// addresses. No mnemonic, seed, or private key appears anywhere in this file —
// the secret-shaped-field tests pass obviously-fake values under forbidden KEY
// names to prove the store refuses them.
const identityFields = (overrides = {}) => ({
  planId: "person-1734",
  sequence: 0,
  source: "scheduled",
  payer: "rFixtur3PayerAcct11111111111111111111",
  destination: "rFixtur3DestAcct11111111111111111111",
  amount: "12.5000",
  currency: "RLUSD",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  sourceTag: 2606250005,
  ...overrides,
});

// The record schema oracle, transcribed from the spec's record sketch —
// independent of the store's own field lists.
const PUBLIC_RECORD_KEYS = Object.freeze([
  "id",
  "installmentId",
  "planId",
  "sequence",
  "source",
  "payer",
  "destination",
  "amount",
  "currency",
  "issuer",
  "sourceTag",
  "hash",
  "ledgerResult",
  "errorClass",
  "state",
  "createdAt",
  "updatedAt",
]);

const SECRET_SHAPED = /seed|phrase|secret|password|mnemonic|privatekey|accessinput/i;
const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;
const FIXED_NOW = 1_760_000_000_000;

const rawRecords = () => JSON.parse(localStorage.getItem(ATTEMPTS_STORAGE_KEY) ?? "[]");

describe("attempt store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createAttempt", () => {
    it("builds a scheduled record with deterministic identity and stamps", () => {
      const record = createAttempt(identityFields());
      expect(record.id).toBe("attempt-person-1734:0-1");
      expect(record.installmentId).toBe("person-1734:0");
      expect(record.state).toBe("scheduled");
      expect(record.createdAt).toBe(FIXED_NOW);
      expect(record.updatedAt).toBe(FIXED_NOW);
      // Outcome fields start empty — they arrive through transitions.
      expect(record.hash).toBeNull();
      expect(record.ledgerResult).toBeNull();
      expect(record.errorClass).toBeNull();
    });

    it("persists the record under cadence-payment-attempts-v1", () => {
      createAttempt(identityFields());
      expect(localStorage.getItem(ATTEMPTS_STORAGE_KEY)).not.toBeNull();
      expect(rawRecords()).toHaveLength(1);
    });

    it("refuses a second attempt while one is awaiting_signature", () => {
      const first = createAttempt(identityFields());
      updateAttempt(first.id, "awaiting_signature");
      expect(() => createAttempt(identityFields())).toThrow(
        /one active attempt per installment/,
      );
    });

    it("refuses a second attempt while one is submitted", () => {
      const first = createAttempt(identityFields());
      updateAttempt(first.id, "awaiting_signature");
      updateAttempt(first.id, "submitted", { hash: "44F0FAKEHASH" });
      expect(() => createAttempt(identityFields())).toThrow(
        /one active attempt per installment/,
      );
    });

    it("refuses a second attempt while one is unresolved", () => {
      const first = createAttempt(identityFields());
      updateAttempt(first.id, "awaiting_signature");
      updateAttempt(first.id, "unresolved");
      expect(() => createAttempt(identityFields())).toThrow(
        /one active attempt per installment/,
      );
    });

    it("numbers retries upward once the previous attempt is terminal", () => {
      const first = createAttempt(identityFields());
      updateAttempt(first.id, "awaiting_signature");
      updateAttempt(first.id, "validated_failure", { errorClass: "sign_rejected" });

      const retry = createAttempt(identityFields());
      expect(retry.id).toBe("attempt-person-1734:0-2");
      expect(retry.state).toBe("scheduled");
      // The failed attempt stays as the durable record of what happened.
      expect(rawRecords()).toHaveLength(2);
    });

    it("requires every identity field", () => {
      for (const key of [
        "planId",
        "sequence",
        "source",
        "payer",
        "destination",
        "amount",
        "currency",
        "issuer",
        "sourceTag",
      ]) {
        const fields = identityFields();
        delete fields[key];
        expect(() => createAttempt(fields)).toThrow(new RegExp(`"${key}"`));
      }
    });

    it("refuses unknown fields", () => {
      expect(() => createAttempt(identityFields({ wat: 1 }))).toThrow(
        /Unknown attempt field "wat"/,
      );
    });

    it("refuses secret-shaped fields outright", () => {
      for (const key of [
        "mnemonic",
        "seed",
        "master_seed",
        "passphrase",
        "account_secret",
        "private_key",
      ]) {
        expect(() =>
          createAttempt(identityFields({ [key]: "fixture-value-not-a-secret" })),
        ).toThrow(/secret-shaped/);
      }
    });

    it("refuses amounts that are not exact decimal strings", () => {
      for (const bad of [12.5, "12,50", "1e3", "-1", "", ".5", "12.5.0", null, undefined]) {
        expect(() => createAttempt(identityFields({ amount: bad }))).toThrow(
          /exact decimal string/,
        );
      }
    });

    it("refuses a bad source", () => {
      expect(() => createAttempt(identityFields({ source: "teleport" }))).toThrow(
        /"source" must be one of/,
      );
    });

    it("refuses a bad sequence", () => {
      expect(() => createAttempt(identityFields({ sequence: 1.5 }))).toThrow(
        /"sequence" must be a non-negative integer/,
      );
      expect(() => createAttempt(identityFields({ sequence: -1 }))).toThrow(
        /"sequence" must be a non-negative integer/,
      );
    });
  });

  describe("updateAttempt", () => {
    it("routes through the domain transition and persists the result", () => {
      const record = createAttempt(identityFields());
      const updated = updateAttempt(record.id, "awaiting_signature");
      expect(updated.state).toBe("awaiting_signature");
      expect(updated.updatedAt).toBe(FIXED_NOW);
      expect(rawRecords()[0].state).toBe("awaiting_signature");
    });

    it("applies outcome patches (hash, ledgerResult, errorClass)", () => {
      const record = createAttempt(identityFields());
      updateAttempt(record.id, "awaiting_signature");
      updateAttempt(record.id, "submitted", { hash: "44F0FAKEHASH" });
      updateAttempt(record.id, "validated_failure", {
        ledgerResult: "tecPATH_DRY",
        errorClass: "network",
      });
      const stored = rawRecords()[0];
      expect(stored.state).toBe("validated_failure");
      expect(stored.hash).toBe("44F0FAKEHASH");
      expect(stored.ledgerResult).toBe("tecPATH_DRY");
      expect(stored.errorClass).toBe("network");
    });

    it("throws on an illegal move and leaves the stored record untouched", () => {
      const record = createAttempt(identityFields());
      expect(() => updateAttempt(record.id, "submitted")).toThrow(
        /Illegal outcome transition scheduled -> submitted/,
      );
      expect(rawRecords()[0].state).toBe("scheduled");
    });

    it("throws on an unknown attempt id", () => {
      expect(() => updateAttempt("attempt-person-1734:0-9", "awaiting_signature")).toThrow(
        /Unknown attempt/,
      );
    });

    it("refuses unknown and secret-shaped patch fields", () => {
      const record = createAttempt(identityFields());
      expect(() => updateAttempt(record.id, "awaiting_signature", { wat: 1 })).toThrow(
        /Unknown attempt field "wat"/,
      );
      expect(() => updateAttempt(record.id, "awaiting_signature", { seed: "x" })).toThrow(
        /secret-shaped/,
      );
    });

    it("refuses patching identity fields — a created attempt's identity is immutable", () => {
      const record = createAttempt(identityFields());
      expect(() =>
        updateAttempt(record.id, "awaiting_signature", { amount: "99.0000" }),
      ).toThrow(/Unknown attempt field "amount"/);
      expect(() =>
        updateAttempt(record.id, "awaiting_signature", { payer: "rOther" }),
      ).toThrow(/Unknown attempt field "payer"/);
    });

    it("refuses an out-of-enum errorClass", () => {
      const record = createAttempt(identityFields());
      updateAttempt(record.id, "awaiting_signature");
      expect(() =>
        updateAttempt(record.id, "validated_failure", { errorClass: "mystery" }),
      ).toThrow(/"errorClass" must be one of/);
    });
  });

  describe("getActiveAttempt", () => {
    it("returns null when nothing is stored", () => {
      expect(getActiveAttempt("person-1734:0")).toBeNull();
    });

    it("tracks the lock through the record's life", () => {
      const record = createAttempt(identityFields());
      // scheduled does not hold the lock — dispatch has not started.
      expect(getActiveAttempt("person-1734:0")).toBeNull();

      updateAttempt(record.id, "awaiting_signature");
      expect(getActiveAttempt("person-1734:0")?.state).toBe("awaiting_signature");

      updateAttempt(record.id, "submitted", { hash: "44F0FAKEHASH" });
      expect(getActiveAttempt("person-1734:0")?.state).toBe("submitted");

      updateAttempt(record.id, "validated_success", { ledgerResult: "tesSUCCESS" });
      // Terminal — the lock is released for the next installment.
      expect(getActiveAttempt("person-1734:0")).toBeNull();
    });

    it("is keyed by installmentId", () => {
      const record = createAttempt(identityFields({ sequence: 0 }));
      updateAttempt(record.id, "awaiting_signature");
      expect(getActiveAttempt("person-1734:0")).not.toBeNull();
      expect(getActiveAttempt("person-1734:1")).toBeNull();
    });
  });

  describe("durability and schema (AC-6)", () => {
    it("records survive a fresh store instance over the same localStorage", async () => {
      const record = createAttempt(identityFields());
      updateAttempt(record.id, "awaiting_signature");
      updateAttempt(record.id, "validated_failure", { errorClass: "sign_rejected" });

      vi.resetModules();
      const fresh = await import("./attemptStore.js");
      // The failed attempt is terminal — the lock is gone, but the record
      // was seen: the fresh instance numbers the retry attempt 2.
      expect(fresh.getActiveAttempt("person-1734:0")).toBeNull();
      const retry = fresh.createAttempt(identityFields());
      expect(retry.id).toBe("attempt-person-1734:0-2");
    });

    it("stores public payment data only — schema assertion over raw localStorage", () => {
      const record = createAttempt(identityFields());
      updateAttempt(record.id, "awaiting_signature");
      updateAttempt(record.id, "submitted", { hash: "44F0FAKEHASH" });
      updateAttempt(record.id, "validated_success", { ledgerResult: "tesSUCCESS" });

      for (const raw of rawRecords()) {
        expect([...Object.keys(raw)].sort()).toEqual([...PUBLIC_RECORD_KEYS].sort());
        for (const key of Object.keys(raw)) {
          expect(SECRET_SHAPED.test(key)).toBe(false);
        }
      }
      expect(rawRecords()[0].ledgerResult).toBe("tesSUCCESS");
    });

    it("keeps amounts as exact decimal strings end-to-end", () => {
      const record = createAttempt(identityFields({ amount: "12.5000" }));
      expect(record.amount).toBe("12.5000");
      const stored = rawRecords().find((r) => r.id === record.id);
      expect(typeof stored.amount).toBe("string");
      expect(stored.amount).toBe("12.5000");
      expect(DECIMAL_STRING.test(stored.amount)).toBe(true);
    });
  });
});
