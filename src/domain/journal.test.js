import { describe, expect, it } from "vitest";
import {
  JOURNAL_CAP,
  attemptOutcomeEntry,
  attemptStartedEntry,
  dispatchRefusedEntry,
  findActiveAttempt,
  hasActiveAttempt,
  nextAttemptNo,
  nextSeq,
  pruneJournal,
  reconcileInFlightAttempts,
} from "./journal.js";
import { OUTCOME_LABELS } from "./installments.js";

const PLAN = { id: "person-1734", name: "Fixture Person" };
const DEST = "rFixtur3DestAcct11111111111111111111";
const PAYER = "rFixtur3PayerAcct11111111111111111111";
const HASH = "44F0FAKEHASH0000000000000000000000000000000000000000000000000000";

const started = (journal = [], journalSeq = 0, overrides = {}) =>
  attemptStartedEntry({
    journal,
    journalSeq,
    plan: PLAN,
    sequence: 0,
    amount: "2.666667",
    destination: DEST,
    payerAddress: PAYER,
    source: "manual",
    ...overrides,
  });

describe("seq and attempt numbering", () => {
  it("numbers seq monotonically from the counter", () => {
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(41)).toBe(42);
    const first = started();
    const second = started(first.journal, first.journalSeq);
    expect(first.entry.seq).toBe(1);
    expect(second.entry.seq).toBe(2);
  });

  it("numbers attempts per installment, ignoring other installments", () => {
    const a1 = started();
    const b1 = started(a1.journal, a1.journalSeq, { plan: { id: "person-other" }, sequence: 0 });
    const a2 = started(b1.journal, b1.journalSeq); // same installment, new attempt
    expect(a1.entry.attemptNo).toBe(1);
    expect(b1.entry.attemptNo).toBe(1);
    expect(a2.entry.attemptNo).toBe(2);
    expect(nextAttemptNo(a2.journal, "person-1734:0")).toBe(3);
  });

  it("stamps an ISO timestamp and never mutates the input journal", () => {
    const journal = [];
    const { journal: next, entry } = started(journal);
    expect(journal).toHaveLength(0);
    expect(next).toHaveLength(1);
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("findActiveAttempt", () => {
  it("returns null with no journal", () => {
    expect(findActiveAttempt([], "person-1734:0")).toBeNull();
    expect(findActiveAttempt(undefined, "person-1734:0")).toBeNull();
  });

  it("holds the lock from attempt_started until a terminal outcome", () => {
    const start = started();
    expect(hasActiveAttempt(start.journal, "person-1734:0")).toBe(true);

    const outcome = attemptOutcomeEntry({
      journal: start.journal,
      journalSeq: start.journalSeq,
      startedEntry: start.entry,
      status: OUTCOME_LABELS.VALIDATED_SUCCESS,
      txHash: HASH,
      ledgerResult: "tesSUCCESS",
    });
    expect(hasActiveAttempt(outcome.journal, "person-1734:0")).toBe(false);
  });

  it("keeps the lock after an unresolved outcome — never auto-retried", () => {
    const start = started();
    const outcome = attemptOutcomeEntry({
      journal: start.journal,
      journalSeq: start.journalSeq,
      startedEntry: start.entry,
      status: OUTCOME_LABELS.UNRESOLVED,
      txHash: HASH,
      reason: "recovered_in_flight",
    });
    const active = findActiveAttempt(outcome.journal, "person-1734:0");
    expect(active).not.toBeNull();
    expect(active.attemptNo).toBe(1);
  });

  it("is keyed per installment", () => {
    const start = started();
    expect(hasActiveAttempt(start.journal, "person-1734:1")).toBe(false);
  });
});

describe("dispatchRefusedEntry", () => {
  it("records refusals with a reason", () => {
    const { journal, journalSeq, entry } = dispatchRefusedEntry({
      journal: [],
      journalSeq: 7,
      plan: PLAN,
      sequence: 2,
      reason: "payer_mismatch",
      detail: "plan pinned to another payer",
    });
    expect(entry).toMatchObject({
      seq: 8,
      type: "dispatch_refused",
      status: "refused",
      installmentId: "person-1734:2",
      planId: "person-1734",
      reason: "payer_mismatch",
    });
    expect(journal).toHaveLength(1);
    expect(journalSeq).toBe(8);
  });
});

describe("reconcileInFlightAttempts", () => {
  it("appends an unresolved outcome for a bare attempt_started", () => {
    const start = started();
    const recovered = reconcileInFlightAttempts(
      { journal: start.journal, journalSeq: start.journalSeq },
      1_760_000_000_000,
    );
    expect(recovered.recovered).toEqual([
      { installmentId: "person-1734:0", attemptNo: 1, at: 1_760_000_000_000 },
    ]);
    expect(recovered.journal).toHaveLength(2);
    const outcome = recovered.journal[1];
    expect(outcome).toMatchObject({
      type: "attempt_outcome",
      status: OUTCOME_LABELS.UNRESOLVED,
      attemptNo: 1,
      reason: "recovered_in_flight",
    });
    // The original started entry is intact — append-only, never rewritten.
    expect(recovered.journal[0]).toEqual(start.entry);
    // The lock stays held: dispatch may not fire until reconciliation.
    expect(hasActiveAttempt(recovered.journal, "person-1734:0")).toBe(true);
  });

  it("leaves terminal attempts alone", () => {
    const start = started();
    const done = attemptOutcomeEntry({
      journal: start.journal,
      journalSeq: start.journalSeq,
      startedEntry: start.entry,
      status: OUTCOME_LABELS.VALIDATED_FAILURE,
      errorClass: undefined,
      reason: "sign_rejected",
    });
    const recovered = reconcileInFlightAttempts({ journal: done.journal, journalSeq: done.journalSeq });
    expect(recovered.recovered).toEqual([]);
    expect(recovered.journal).toHaveLength(2);
  });

  it("recovers each in-flight attempt exactly once (StrictMode double-mount)", () => {
    const start = started();
    const once = reconcileInFlightAttempts({ journal: start.journal, journalSeq: start.journalSeq });
    const twice = reconcileInFlightAttempts({ journal: once.journal, journalSeq: once.journalSeq });
    expect(twice.recovered).toEqual([]);
    expect(twice.journal).toHaveLength(2);
  });
});

describe("pruneJournal", () => {
  // Bulk entries are terminalized immediately so tests control exactly which
  // attempts are protected. Each pair costs two seq numbers.
  const appendTerminalPair = (journal, journalSeq, planId) => {
    const appended = attemptStartedEntry({
      journal,
      journalSeq,
      plan: { id: planId },
      sequence: 0,
      amount: "1.000000",
      destination: DEST,
      payerAddress: PAYER,
      source: "scheduled",
    });
    const done = attemptOutcomeEntry({
      journal: appended.journal,
      journalSeq: appended.journalSeq,
      startedEntry: appended.entry,
      status: OUTCOME_LABELS.VALIDATED_FAILURE,
      reason: "sign_rejected",
    });
    return done;
  };

  const fill = (count, journal = [], journalSeq = 0) => {
    let state = { journal, journalSeq };
    for (let i = 0; i < count; i += 1) {
      state = appendTerminalPair(state.journal, state.journalSeq, `person-${i}`);
    }
    return state;
  };

  it("keeps journals under the cap untouched", () => {
    const { journal } = fill(3);
    expect(pruneJournal(journal)).toBe(journal);
  });

  it("caps at JOURNAL_CAP entries and keeps the newest", () => {
    const { journal } = fill(JOURNAL_CAP / 2 + 10); // 520 entries
    const pruned = pruneJournal(journal);
    expect(pruned.length).toBe(JOURNAL_CAP);
    expect(pruned.at(-1).seq).toBe(journal.at(-1).seq);
    // Terminal pairs age out — the oldest survived entries are not seq 1.
    expect(pruned[0].seq).toBeGreaterThan(1);
  });

  it("never drops an attempt that is still active, even outside the cap window", () => {
    const lock = started([], 0, { plan: { id: "person-active" }, sequence: 0 });
    const filled = fill(JOURNAL_CAP / 2 + 5, lock.journal, lock.journalSeq);
    const pruned = pruneJournal(filled.journal);
    expect(pruned.length).toBeGreaterThan(JOURNAL_CAP); // soft cap: protection wins
    expect(pruned.some((e) => e.seq === lock.entry.seq)).toBe(true);
  });

  it("never drops an unresolved attempt or its recovery outcome", () => {
    const start = started([], 0, { plan: { id: "person-unresolved" }, sequence: 0 });
    const outcome = attemptOutcomeEntry({
      journal: start.journal,
      journalSeq: start.journalSeq,
      startedEntry: start.entry,
      status: OUTCOME_LABELS.UNRESOLVED,
      txHash: HASH,
      reason: "recovered_in_flight",
    });
    const filled = fill(JOURNAL_CAP / 2 + 5, outcome.journal, outcome.journalSeq);
    const pruned = pruneJournal(filled.journal);
    expect(pruned.some((e) => e.seq === start.entry.seq)).toBe(true);
    expect(pruned.some((e) => e.seq === outcome.entry.seq)).toBe(true);
  });

  it("keeps seq monotonic after pruning — pruned seqs are never reused", () => {
    const filled = fill(JOURNAL_CAP / 2 + 10);
    const pruned = pruneJournal(filled.journal);
    const next = started(pruned, filled.journalSeq);
    expect(next.entry.seq).toBe(filled.journalSeq + 1);
  });
});

