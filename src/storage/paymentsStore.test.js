import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_CAP,
  PLAN_FIELDS,
  QUARANTINE_KEY,
  SCHEMA_VERSION,
  STORE_KEY,
  assertNoSecretMaterial,
  canonicalJson,
  checksumOf,
  load,
  save,
} from "./paymentsStore.js";

const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DEST = "rFixtur3DestAcct11111111111111111111";
const HASH = "44F0FAKEHASH0000000000000000000000000000000000000000000000000000";

const planFixture = (overrides = {}) => ({
  id: "person-1734",
  name: "Fixture Person",
  role: "Payroll",
  email: "person@fixture.test",
  address: DEST,
  payerAddress: PAYER,
  weeklyPay: "16",
  payMode: "weekly",
  hourlyPay: "20",
  hoursPerWeek: "40",
  frequency: "minute",
  active: true,
  paidCount: 3,
  nextRunAt: 1_760_002_206_000,
  ...overrides,
});

const historyFixture = () => [
  {
    id: "history-1",
    at: "2026-10-09T17:41:00.000Z",
    status: "success",
    title: "Payment submitted",
    detail: `Fixture - tag 2606250005 - ${HASH}`,
  },
];

const journalFixture = () => [
  {
    seq: 1,
    at: "2026-10-09T17:41:02.000Z",
    type: "attempt_started",
    status: "submitted",
    installmentId: "person-1734:3",
    planId: "person-1734",
    sequence: 3,
    attemptNo: 1,
    amount: "2.666667",
    destination: DEST,
    payerAddress: PAYER,
    source: "scheduled",
  },
  {
    seq: 2,
    at: "2026-10-09T17:41:05.000Z",
    type: "attempt_outcome",
    status: "validated_success",
    installmentId: "person-1734:3",
    attemptNo: 1,
    txHash: HASH,
    ledgerResult: "tesSUCCESS",
  },
];

const docFixture = (overrides = {}) => ({
  plans: [planFixture()],
  history: historyFixture(),
  journal: journalFixture(),
  journalSeq: 2,
  ...overrides,
});

const storedDoc = () => JSON.parse(localStorage.getItem(STORE_KEY));

beforeEach(() => {
  window.localStorage.clear();
});

describe("canonicalJson and checksum", () => {
  it("is stable under key order", () => {
    const a = canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] });
    const b = canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 });
    expect(a).toBe(b);
  });

  it("changes when the document changes", async () => {
    const doc = docFixture();
    const other = docFixture({ plans: [planFixture({ paidCount: 4 })] });
    expect(await checksumOf(doc)).not.toBe(await checksumOf(other));
    expect(await checksumOf(doc)).toBe(await checksumOf(docFixture()));
  });
});

describe("save/load round trip", () => {
  it("restores plans, history, and journal with progress intact", async () => {
    const saveResult = await save(docFixture());
    expect(saveResult.ok).toBe(true);

    const result = await load();
    expect(result.status).toBe("ok");
    expect(result.data.plans).toEqual([planFixture()]);
    expect(result.data.history).toEqual(historyFixture());
    expect(result.data.journal).toEqual(journalFixture());
    expect(result.data.journalSeq).toBe(2);
  });

  it("stores schemaVersion, savedAt, and a verifying checksum", async () => {
    await save(docFixture());
    const stored = storedDoc();
    expect(stored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof stored.savedAt).toBe("string");
    expect(typeof stored.checksum).toBe("string");

    const { checksum, ...payload } = stored;
    expect(checksum).toBe(await checksumOf(payload));
  });

  it("drops unknown plan fields on save — never persisted, never resurrected", async () => {
    await save(docFixture({ plans: [planFixture({ draftState: "editor-noise", signingBlob: "NOT_SECRET_JUST_UNKNOWN" })] }));
    const stored = storedDoc();
    expect(stored.plans[0].draftState).toBeUndefined();
    expect(stored.plans[0].signingBlob).toBeUndefined();
    for (const key of Object.keys(stored.plans[0])) {
      expect(PLAN_FIELDS.includes(key)).toBe(true);
    }
  });

  it("caps stored history at the newest HISTORY_CAP rows", async () => {
    const history = Array.from({ length: HISTORY_CAP + 30 }, (_, index) => ({
      id: `history-${index}`,
      at: "2026-10-09T17:41:00.000Z",
      status: "success",
      title: `row ${index}`,
      detail: "",
    }));
    await save(docFixture({ history }));
    const stored = storedDoc();
    expect(stored.history).toHaveLength(HISTORY_CAP);
    expect(stored.history[0].id).toBe("history-0"); // newest first (prepending list)
  });
});

describe("load failure states", () => {
  it("reports empty when nothing is stored", async () => {
    expect(await load()).toEqual({ status: "empty" });
  });

  it("quarantines unparseable JSON and starts empty, without throwing", async () => {
    localStorage.setItem(STORE_KEY, "{not json at all");
    const result = await load();
    expect(result.status).toBe("corrupt");
    expect(result.reason).toContain("unparseable_json");
    expect(result.quarantine.stored).toBe(true);
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.raw).toBe("{not json at all");
    expect(quarantined.reason).toBe("unparseable_json");
  });

  it("quarantines a tampered checksum instead of trusting the payload", async () => {
    await save(docFixture());
    const stored = storedDoc();
    stored.plans[0].paidCount = 99; // tampering
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const result = await load();
    expect(result.status).toBe("corrupt");
    expect(result.reason).toBe("checksum_mismatch");
    expect(result.data).toBeUndefined();
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.reason).toBe("checksum_mismatch");
    expect(JSON.parse(quarantined.raw).plans[0].paidCount).toBe(99);
  });

  it("quarantines an unknown future schemaVersion — never guessed at, never downgraded", async () => {
    await save(docFixture());
    const stored = storedDoc();
    stored.schemaVersion = 99;
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const result = await load();
    expect(result.status).toBe("unknown_version");
    expect(result.schemaVersion).toBe(99);
    expect(result.data).toBeUndefined();
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.schemaVersion).toBe(99);
    expect(JSON.parse(quarantined.raw).plans).toHaveLength(1);
  });

  it("excludes invalid plan rows but preserves them in invalidEntries", async () => {
    await save(docFixture());
    const stored = storedDoc();
    stored.plans.push(
      { ...planFixture({ id: "person-bad-freq", frequency: "fortnight" }) },
      { ...planFixture({ id: "person-bad-count", paidCount: 2.5 }) },
    );
    // Re-sign the tampered doc so checksum passes and row validation runs.
    const { checksum, ...payload } = stored;
    stored.checksum = await checksumOf(payload);
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const result = await load();
    expect(result.status).toBe("invalid");
    expect(result.data.plans.map((plan) => plan.id)).toEqual(["person-1734"]);
    expect(result.invalidEntries.map((entry) => entry.row.id)).toEqual([
      "person-bad-freq",
      "person-bad-count",
    ]);
    expect(result.data.plans[0]).toEqual(planFixture());
  });

  it("treats a non-object document as corrupt", async () => {
    localStorage.setItem(STORE_KEY, "[1,2,3]");
    const result = await load();
    expect(result.status).toBe("corrupt");
    expect(result.reason).toBe("not_an_object");
  });
});

describe("secret exclusion", () => {
  it("aborts save when a plan carries an accessInput-shaped mnemonic field", async () => {
    expect(() =>
      assertNoSecretMaterial({ plans: [{ ...planFixture(), accessInput: "fixture words are not a real seed" }] }),
    ).toThrow(/accessInput/i);
    expect(() =>
      assertNoSecretMaterial({ plans: [{ ...planFixture(), master_seed: "fixture" }] }),
    ).toThrow(/master_seed/i);
    expect(() =>
      assertNoSecretMaterial({ plans: [{ ...planFixture(), privateKey: "fixture" }] }),
    ).toThrow(/privateKey/i);
  });

  it("aborts save on a signed-blob-shaped value", async () => {
    const hexBlob = "A1B2C3D4".repeat(50); // 400 hex chars — signed-blob shape
    expect(() => assertNoSecretMaterial({ plans: [{ ...planFixture(), note: hexBlob }] })).toThrow(
      /signed-blob-shaped/,
    );
  });

  it("refuses blob-named keys outright", () => {
    expect(() => assertNoSecretMaterial({ plans: [{ ...planFixture(), tx_blob: "SHORT" }] })).toThrow(/tx_blob/i);
  });

  it("never writes a secret-bearing document to localStorage", async () => {
    // The whitelist drops unknown fields before the assertion even runs —
    // a mnemonic sneaking in under an unknown key cannot reach storage.
    await save(docFixture({ plans: [{ ...planFixture(), accessInput: "fixture" }] }));
    const stored = storedDoc();
    expect(stored.plans).toHaveLength(1);
    expect(Object.keys(stored.plans[0]).join(",")).not.toMatch(/accessinput/i);
  });

  it("keeps a full wallet-shaped state dump out of the document", async () => {
    // The shape a naive state-dump persistence would produce.
    const stateDump = {
      plans: [planFixture()],
      history: [],
      journal: [],
      journalSeq: 0,
      signingWallet: { seed: "sEdFixtureNotASeed", privateKey: "fixture" },
    };
    expect(() => assertNoSecretMaterial(stateDump)).toThrow(/seed|privateKey/i);
  });
});

describe("save failure handling", () => {
  it("resolves { ok: false } on a failing setItem instead of throwing", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const result = await save(docFixture());
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("QuotaExceededError");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
