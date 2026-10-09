import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_CAP,
  HISTORY_FIELDS,
  JOURNAL_FIELDS,
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

const historyFixture = () => [
  {
    id: "history-1",
    at: "2026-10-09T17:41:00.000Z",
    status: "success",
    title: "Payment submitted",
    detail: `Fixture - tag 2606250005 - ${HASH}`,
  },
  {
    id: "history-2",
    at: "2026-10-09T17:40:00.000Z",
    status: "failed",
    title: "Payment failed",
    detail: "Wallet confirmation was cancelled.",
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

// The record document: history + append-only journal. Plans live in
// planState (cadence-plans-v1) — this document never carries them.
const docFixture = (overrides = {}) => ({
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
    const other = docFixture({
      journal: [
        ...journalFixture(),
        { ...journalFixture()[0], seq: 3, installmentId: "person-1734:4", type: "attempt_outcome", status: "validated_failure" },
      ],
    });
    expect(await checksumOf(doc)).not.toBe(await checksumOf(other));
    expect(await checksumOf(doc)).toBe(await checksumOf(docFixture()));
  });
});

describe("save/load round trip", () => {
  it("restores history and the journal intact", async () => {
    const saveResult = await save(docFixture());
    expect(saveResult.ok).toBe(true);

    const result = await load();
    expect(result.status).toBe("ok");
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

  it("keeps the newest-first history order across save and load", async () => {
    await save(docFixture());
    const result = await load();
    expect(result.data.history.map((row) => row.id)).toEqual(["history-1", "history-2"]);
  });

  it("drops unknown row fields on save — never persisted, never resurrected", async () => {
    await save(docFixture({
      history: [{ ...historyFixture()[0], draftState: "editor-noise", signingBlob: "NOT_SECRET_JUST_UNKNOWN" }],
      journal: [{ ...journalFixture()[0], walletSnapshot: { seed: "fixture" } }],
    }));
    const stored = storedDoc();
    expect(stored.history[0].draftState).toBeUndefined();
    expect(stored.history[0].signingBlob).toBeUndefined();
    for (const key of Object.keys(stored.history[0])) {
      expect(HISTORY_FIELDS.includes(key)).toBe(true);
    }
    for (const key of Object.keys(stored.journal[0])) {
      expect(JOURNAL_FIELDS.includes(key)).toBe(true);
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
    // Newest-first list: history-0 is the newest row and must survive.
    await save(docFixture({ history }));
    const stored = storedDoc();
    expect(stored.history).toHaveLength(HISTORY_CAP);
    expect(stored.history[0].id).toBe("history-0");
  });

  it("never lets journalSeq regress below the highest stored seq", async () => {
    await save(docFixture({ journalSeq: 0 }));
    const result = await load();
    expect(result.data.journalSeq).toBe(2);
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

  it("quarantines a tampered payload instead of trusting it", async () => {
    await save(docFixture());
    const stored = storedDoc();
    stored.journal[1].ledgerResult = "tecKILLED"; // tampering
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const result = await load();
    expect(result.status).toBe("corrupt");
    expect(result.reason).toBe("checksum_mismatch");
    expect(result.data).toBeUndefined();
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.reason).toBe("checksum_mismatch");
    expect(JSON.parse(quarantined.raw).journal[1].ledgerResult).toBe("tecKILLED");
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
    expect(JSON.parse(quarantined.raw).journal).toHaveLength(2);
  });

  it("excludes invalid rows but preserves them in invalidEntries", async () => {
    await save(docFixture());
    const stored = storedDoc();
    stored.history.push({ id: "", title: "row without a valid id" });
    stored.journal.push({ seq: 0, type: "attempt_started", installmentId: "no-seq" });
    stored.journal.push({ seq: 3, type: "attempt_outcome", status: "made_up_label", installmentId: "x:1" });
    // Re-sign the tampered doc so checksum passes and row validation runs.
    const { checksum, ...payload } = stored;
    stored.checksum = await checksumOf(payload);
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const result = await load();
    expect(result.status).toBe("invalid");
    expect(result.data.history.map((row) => row.id)).toEqual(["history-1", "history-2"]);
    expect(result.data.journal.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(result.invalidEntries.map((entry) => entry.reason)).toEqual([
      "invalid_history_row",
      "invalid_journal_entry",
      "invalid_journal_entry",
    ]);
  });

  it("treats a non-object document as corrupt", async () => {
    localStorage.setItem(STORE_KEY, "[1,2,3]");
    const result = await load();
    expect(result.status).toBe("corrupt");
    expect(result.reason).toBe("not_an_object");
  });

  it("treats a missing or non-integer schemaVersion as corrupt", async () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ history: [], journal: [] }));
    const result = await load();
    expect(result.status).toBe("corrupt");
    expect(result.reason).toBe("missing_or_invalid_schemaVersion");
  });
});

describe("secret exclusion", () => {
  it("aborts when a record carries an accessInput-shaped mnemonic field", () => {
    expect(() =>
      assertNoSecretMaterial({ history: [{ ...historyFixture()[0], accessInput: "fixture words are not a real seed" }] }),
    ).toThrow(/accessInput/i);
    expect(() =>
      assertNoSecretMaterial({ journal: [{ ...journalFixture()[0], master_seed: "fixture" }] }),
    ).toThrow(/master_seed/i);
    expect(() =>
      assertNoSecretMaterial({ journal: [{ ...journalFixture()[0], privateKey: "fixture" }] }),
    ).toThrow(/privateKey/i);
  });

  it("aborts on a signed-blob-shaped value", () => {
    const hexBlob = "A1B2C3D4".repeat(50); // 400 hex chars — signed-blob shape
    expect(() => assertNoSecretMaterial({ history: [{ ...historyFixture()[0], note: hexBlob }] })).toThrow(
      /signed-blob-shaped/,
    );
  });

  it("refuses blob-named keys outright", () => {
    expect(() => assertNoSecretMaterial({ history: [{ ...historyFixture()[0], tx_blob: "SHORT" }] })).toThrow(/tx_blob/i);
  });

  it("never writes a secret-bearing document to localStorage", async () => {
    // The whitelist drops unknown fields before the assertion even runs —
    // a mnemonic sneaking in under an unknown key cannot reach storage.
    await save(docFixture({
      journal: [{ ...journalFixture()[0], accessInput: "fixture" }],
    }));
    const stored = storedDoc();
    expect(stored.journal).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toMatch(/accessinput/i);
  });

  it("keeps a full wallet-shaped state dump out of the document", async () => {
    // The shape a naive state-dump persistence would produce: save() copies
    // named fields only, so the dump is ignored outright — and the raw
    // assertion throws for any caller that bypasses the whitelist.
    const stateDump = {
      history: historyFixture(),
      journal: journalFixture(),
      journalSeq: 2,
      signingWallet: { seed: "sEdFixtureNotASeed", privateKey: "fixture" },
      accessInput: "fixture words",
    };
    expect(() => assertNoSecretMaterial(stateDump)).toThrow(/seed|privateKey|accessInput/i);

    await save(stateDump);
    const stored = storedDoc();
    expect(JSON.stringify(stored)).not.toMatch(/signingwallet|seed|privatekey|accessinput/i);
    expect(stored.history).toHaveLength(2);
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
