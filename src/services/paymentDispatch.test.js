import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyValidatedFailureRetry,
  applyValidatedSuccess,
  classifySubmitError,
} from "../domain/paymentOutcome.js";
import * as attemptStore from "../storage/attemptStore.js";
import { ACTIVE_EXPIRY_MS, createPaymentDispatch } from "./paymentDispatch.js";

// The dispatch orchestrator's own contract test. The store and the error
// classifier are the real modules; the normalizer is the identity (receipts
// below are already in the normalized { hash, ledgerResult } shape — shape
// coverage lives in normalizeOutcome.test.js) and the ledger reconciler is a
// mock, so no test ever opens a socket. No mnemonic, seed, or private key
// appears anywhere — payer/destination are synthetic mainnet-format addresses.
const TX_HASH = "44F0A1B2C3D4E5F60718293A4B5C6D7E8F901234567890ABCDEF0123456789AB";
const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DESTINATION = "rFixtur3DestAcct11111111111111111111";
const FIXED_NOW = 1_760_000_000_000;

const identityFields = (overrides = {}) => ({
  planId: "person-1734",
  sequence: 0,
  source: "scheduled",
  payer: PAYER,
  destination: DESTINATION,
  amount: "12.5000",
  currency: "RLUSD",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  sourceTag: 2606250005,
  ...overrides,
});

const buildDispatch = ({ reconcileAttempt } = {}) =>
  createPaymentDispatch({
    attemptStore,
    normalizeSubmitOutcome: (raw) => raw,
    classifySubmitError,
    reconciler: { reconcileAttempt: reconcileAttempt ?? vi.fn() },
  });

// plan snapshot as payInstallment passes it; sequence derives from paidCount.
const PLAN = { id: "person-1734", paidCount: 0 };
const CONTEXT = (submit, overrides = {}) => ({
  source: "scheduled",
  label: "Ada",
  payer: PAYER,
  destination: DESTINATION,
  amount: "12.5000",
  currency: "RLUSD",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  sourceTag: 2606250005,
  submit,
  ...overrides,
});

const seedUnresolved = ({ hash = null, sequence = 0 } = {}) => {
  const seeded = attemptStore.createAttempt(identityFields({ sequence }));
  attemptStore.updateAttempt(seeded.id, "awaiting_signature");
  attemptStore.updateAttempt(seeded.id, "submitted", hash ? { hash } : {});
  attemptStore.updateAttempt(seeded.id, "unresolved");
  return seeded;
};

describe("guarded payment dispatch", () => {
  let dispatch;
  let reconcileAttempt;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    reconcileAttempt = vi.fn();
    dispatch = buildDispatch({ reconcileAttempt });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists awaiting_signature before invoking submit", async () => {
    let stateAtSubmit = null;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const inflight = dispatch.dispatch(
      PLAN,
      CONTEXT(() => {
        stateAtSubmit = attemptStore.getActiveAttempt("person-1734:0")?.state;
        return gate;
      }),
      () => {},
    );
    expect(stateAtSubmit).toBe("awaiting_signature");
    expect(attemptStore.listAttempts()).toHaveLength(1);
    release({ hash: TX_HASH, ledgerResult: "tesSUCCESS" });
    const record = await inflight;
    expect(record.state).toBe("validated_success");
  });

  it("settles a tesSUCCESS receipt as validated_success without reconciling", async () => {
    const events = [];
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({ hash: TX_HASH, ledgerResult: "tesSUCCESS" })),
      (event) => events.push(event),
    );
    expect(record.state).toBe("validated_success");
    expect(record.ledgerResult).toBe("tesSUCCESS");
    expect(record.hash).toBe(TX_HASH);
    expect(events.map((e) => e.type)).toEqual(["awaiting_signature", "validated_success"]);
    expect(reconcileAttempt).not.toHaveBeenCalled();
  });

  it("settles a final failure receipt (tec*) as validated_failure without reconciling", async () => {
    const events = [];
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({ hash: TX_HASH, ledgerResult: "tecUNFUNDED_PAYMENT" })),
      (event) => events.push(event),
    );
    expect(record.state).toBe("validated_failure");
    expect(events.map((e) => e.type)).toEqual(["awaiting_signature", "validated_failure"]);
    expect(reconcileAttempt).not.toHaveBeenCalled();
  });

  it("reconciles a hash-only receipt through the injected reconciler", async () => {
    reconcileAttempt.mockResolvedValue({ next: "validated_success", ledgerResult: "tesSUCCESS" });
    const events = [];
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({ hash: TX_HASH, ledgerResult: null })),
      (event) => events.push(event),
    );
    expect(record.state).toBe("validated_success");
    expect(events.map((e) => e.type)).toEqual(["awaiting_signature", "submitted", "validated_success"]);
    expect(reconcileAttempt).toHaveBeenCalledWith(expect.objectContaining({ hash: TX_HASH }));
  });

  it("holds unresolved when the response carries neither hash nor verdict", async () => {
    const events = [];
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({})),
      (event) => events.push(event),
    );
    expect(record.state).toBe("unresolved");
    expect(events.map((e) => e.type)).toEqual(["awaiting_signature", "unresolved"]);
    expect(reconcileAttempt).not.toHaveBeenCalled();
  });

  it("classifies sign rejection as validated_failure — provably pre-submission", async () => {
    const events = [];
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => {
        throw Object.assign(new Error("Transaction signing was rejected by the user."), {
          code: "SIGN_REJECTED",
        });
      }),
      (event) => events.push(event),
    );
    expect(record.state).toBe("validated_failure");
    expect(record.errorClass).toBe("sign_rejected");
    expect(events.map((e) => e.type)).toEqual(["awaiting_signature", "validated_failure"]);
  });

  it("holds unresolved on network errors after submission started", async () => {
    const events = [];
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => {
        throw new Error("network timeout while submitting");
      }),
      (event) => events.push(event),
    );
    expect(record.state).toBe("unresolved");
    expect(record.errorClass).toBe("network");
    expect(events.map((e) => e.type)).toEqual(["awaiting_signature", "unresolved"]);
    // The orchestrator never reschedules: no validated_success event carries
    // plan mutations, and no retry logic exists in the flow at all.
    expect(events.every((e) => e.type !== "validated_success")).toBe(true);
  });

  // AC-5: manual + scheduler fired simultaneously for one installment.
  it("refuses a second dispatch while an attempt is active", async () => {
    const eventsA = [];
    const eventsB = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = dispatch.dispatch(
      PLAN,
      CONTEXT(() => gate), // hold the lock
      (event) => eventsA.push(event),
    );
    const second = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({ hash: TX_HASH, ledgerResult: "tesSUCCESS" })),
      (event) => eventsB.push(event),
    );
    expect(second).toBeNull();
    expect(eventsB.map((e) => e.type)).toEqual(["lock_refused"]);
    expect(attemptStore.listAttempts()).toHaveLength(1); // exactly one attempt record
    expect(eventsA.some((e) => e.type === "awaiting_signature")).toBe(true);
    release({ hash: TX_HASH, ledgerResult: "tesSUCCESS" });
    await first;
  });

  // Fail-closed absorb (PR #9's pattern): a store failure before submission
  // blocks the payment entirely — surfaced as store_failed, never classified
  // as an outcome, and nothing is ever submitted untracked.
  it("emits store_failed and blocks the payment when the record cannot be created", async () => {
    const submit = vi.fn(() => ({ hash: TX_HASH, ledgerResult: "tesSUCCESS" }));
    const spy = vi.spyOn(attemptStore, "createAttempt").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const events = [];
    const result = await dispatch.dispatch(PLAN, CONTEXT(submit), (event) => events.push(event));
    spy.mockRestore();
    expect(result).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(attemptStore.listAttempts()).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["store_failed"]);
    expect(events[0].planId).toBe("person-1734");
    expect(events[0].sequence).toBe(0);
  });

  it("emits store_failed and blocks the payment when awaiting_signature cannot persist", async () => {
    const submit = vi.fn(() => ({ hash: TX_HASH, ledgerResult: "tesSUCCESS" }));
    const spy = vi.spyOn(attemptStore, "updateAttempt").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const events = [];
    const result = await dispatch.dispatch(PLAN, CONTEXT(submit), (event) => events.push(event));
    spy.mockRestore();
    expect(result).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(["store_failed"]);
  });

  it("opens a fresh attempt record for a retry after a terminal outcome", async () => {
    await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({ hash: TX_HASH, ledgerResult: "tesSUCCESS" })),
      () => {},
    );
    const record = await dispatch.dispatch(
      PLAN,
      CONTEXT(() => ({ hash: TX_HASH, ledgerResult: "tesSUCCESS" })),
      () => {},
    );
    expect(record.state).toBe("validated_success");
    expect(record.id).toBe("attempt-person-1734:0-2");
    expect(attemptStore.listAttempts()).toHaveLength(2);
  });
});

describe("reconciliation pass", () => {
  let dispatch;
  let reconcileAttempt;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    reconcileAttempt = vi.fn();
    dispatch = buildDispatch({ reconcileAttempt });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a hashed unresolved attempt to validated_success on the pass", async () => {
    const seeded = seedUnresolved({ hash: TX_HASH });
    reconcileAttempt.mockResolvedValue({ next: "validated_success", ledgerResult: "tesSUCCESS" });
    const events = [];
    await dispatch.runReconciliationPass((event) => events.push(event));
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("validated_success");
    expect(events.map((e) => e.type)).toEqual(["validated_success"]);
  });

  it("keeps unresolved on txnNotFound (not final yet)", async () => {
    const seeded = seedUnresolved({ hash: TX_HASH });
    reconcileAttempt.mockResolvedValue({ next: "unresolved" });
    const events = [];
    await dispatch.runReconciliationPass((event) => events.push(event));
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("unresolved");
    expect(events).toEqual([]);
  });

  it("settles a hashed unresolved attempt to validated_failure on a final code", async () => {
    const seeded = seedUnresolved({ hash: TX_HASH });
    reconcileAttempt.mockResolvedValue({
      next: "validated_failure",
      ledgerResult: "tecUNFUNDED_PAYMENT",
    });
    const events = [];
    await dispatch.runReconciliationPass((event) => events.push(event));
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("validated_failure");
    expect(record.ledgerResult).toBe("tecUNFUNDED_PAYMENT");
    expect(events.map((e) => e.type)).toEqual(["validated_failure"]);
  });

  it("never reconciles hashless unresolved attempts", async () => {
    seedUnresolved({ hash: null });
    await dispatch.runReconciliationPass(() => {});
    expect(reconcileAttempt).not.toHaveBeenCalled();
    expect(attemptStore.listAttempts()[0].state).toBe("unresolved");
  });

  it("expires a stale no-hash awaiting_signature to unresolved — never to failure", async () => {
    const seeded = attemptStore.createAttempt(identityFields());
    attemptStore.updateAttempt(seeded.id, "awaiting_signature");
    vi.setSystemTime(FIXED_NOW + ACTIVE_EXPIRY_MS + 1);
    const events = [];
    await dispatch.runReconciliationPass((event) => events.push(event));
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("unresolved");
    expect(events.map((e) => e.type)).toEqual(["expired_to_unresolved"]);
    expect(events.some((e) => e.type === "validated_failure")).toBe(false);
  });

  it("leaves a fresh awaiting_signature attempt alone", async () => {
    const seeded = attemptStore.createAttempt(identityFields());
    attemptStore.updateAttempt(seeded.id, "awaiting_signature");
    await dispatch.runReconciliationPass(() => {});
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("awaiting_signature");
    expect(reconcileAttempt).not.toHaveBeenCalled();
  });

  it("creates no new attempts and never auto-retries during the pass", async () => {
    seedUnresolved({ hash: TX_HASH });
    reconcileAttempt.mockResolvedValue({ next: "unresolved" });
    await dispatch.runReconciliationPass(() => {});
    expect(attemptStore.listAttempts()).toHaveLength(1); // no new attempt appeared
    expect(attemptStore.listAttempts()[0].source).toBe("scheduled"); // untouched origin
  });

  it("skips the settle when the record left unresolved mid-pass", async () => {
    const seeded = seedUnresolved({ hash: TX_HASH });
    reconcileAttempt.mockImplementation(async (record) => {
      attemptStore.updateAttempt(record.id, "validated_success"); // concurrent settle wins
      return { next: "validated_failure", ledgerResult: "tecUNFUNDED_PAYMENT" };
    });
    await dispatch.runReconciliationPass(() => {});
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("validated_success"); // concurrent settle preserved
  });

  it("surfaces a failing lookup and keeps the attempt unresolved", async () => {
    const seeded = seedUnresolved({ hash: TX_HASH });
    reconcileAttempt.mockRejectedValue(new Error("websocket unavailable"));
    const events = [];
    await dispatch.runReconciliationPass((event) => events.push(event));
    const record = attemptStore.listAttempts().find((r) => r.id === seeded.id);
    expect(record.state).toBe("unresolved");
    expect(events.map((e) => e.type)).toEqual(["reconcile_failed"]);
  });
});

// AC-3: paidCount, nextRunAt, and plan completion move only on
// validated_success — the helpers are the only plan-mutation surface the
// dashboard's event handler applies.
describe("plan mutation helpers (counting contract)", () => {
  const person = { id: "person-1734", paidCount: 0, active: true, nextRunAt: null };

  it("applyValidatedSuccess advances the count once and sets nextRunAt", () => {
    const updated = applyValidatedSuccess(person, { sequence: 0, payments: 4, frequencyMs: 604800000, now: FIXED_NOW });
    expect(updated.paidCount).toBe(1);
    expect(updated.active).toBe(true);
    expect(updated.nextRunAt).toBe(FIXED_NOW + 604800000);
  });

  it("applyValidatedSuccess completes the plan on the final installment", () => {
    const updated = applyValidatedSuccess({ ...person, paidCount: 3 }, { sequence: 3, payments: 4, frequencyMs: 604800000, now: FIXED_NOW });
    expect(updated.paidCount).toBe(4);
    expect(updated.active).toBe(false);
    expect(updated.nextRunAt).toBeNull();
  });

  it("applyValidatedSuccess ignores a stale sequence instead of double-advancing", () => {
    const updated = applyValidatedSuccess({ ...person, paidCount: 1 }, { sequence: 0, payments: 4, frequencyMs: 604800000, now: FIXED_NOW });
    expect(updated.paidCount).toBe(1);
    expect(updated.nextRunAt).toBeNull();
  });

  it("applyValidatedFailureRetry defers the retry without touching the count", () => {
    const updated = applyValidatedFailureRetry(person, { now: FIXED_NOW });
    expect(updated.paidCount).toBe(0);
    expect(updated.nextRunAt).toBe(FIXED_NOW + 60000);
  });

  it("applyValidatedFailureRetry never pulls an existing nextRunAt earlier", () => {
    const updated = applyValidatedFailureRetry({ ...person, nextRunAt: FIXED_NOW + 999999 }, { now: FIXED_NOW });
    expect(updated.nextRunAt).toBe(FIXED_NOW + 999999);
  });
});
