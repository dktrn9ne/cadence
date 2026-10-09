// Append-only payment journal — pure functions over the journal array that
// lives inside the cadence.payments.v1 document. The journal is the durable
// record of what actually happened to each installment attempt:
//
//   attempt_started  — written BEFORE dispatch (closes the crash window)
//   attempt_outcome  — exactly one per started attempt, labeled honestly:
//                      validated_success | validated_failure | unresolved
//                      | failed_no_hash
//   dispatch_refused — a dispatch path refused to fire (active attempt,
//                      payer mismatch, storage halt); recorded, not silent
//
// Nothing here submits, retries, or touches the ledger. Active-attempt lookup
// and the prune policy are the safety core: a prune may never drop an entry
// that keeps an attempt active or unresolved.
import { OUTCOME_LABELS, installmentIdFor } from "./installments.js";

export const JOURNAL_ENTRY_TYPES = Object.freeze([
  "attempt_started",
  "attempt_outcome",
  "dispatch_refused",
]);

// Attempt-started entries carry status "submitted" (dispatch is happening);
// attempt_outcome statuses are the outcome labels from installments.js.
export const ATTEMPT_STARTED_STATUS = "submitted";

export const JOURNAL_CAP = 500;

const STARTED_FIELDS = Object.freeze([
  "installmentId",
  "planId",
  "sequence",
  "attemptNo",
  "amount",
  "destination",
  "payerAddress",
  "source",
]);
const OUTCOME_FIELDS = Object.freeze(["installmentId", "attemptNo", "txHash", "ledgerResult", "error", "reason"]);
const REFUSED_FIELDS = Object.freeze(["installmentId", "planId", "sequence", "reason", "detail"]);

// Whitelist-copy of a journal entry: unknown fields are dropped, never
// persisted. Secret-shaped keys are refused by the store's assertion before
// anything reaches localStorage.
export const copyEntryFields = (fields, allowed) => {
  const copy = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) copy[key] = fields[key];
  }
  return copy;
};

export const nextSeq = (journalSeq) => (Number.isInteger(journalSeq) ? journalSeq : 0) + 1;

// The attempt number for the NEXT attempt on an installment: started entries
// count (outcome entries repeat the attemptNo rather than incrementing it).
export const nextAttemptNo = (journal, installmentId) =>
  journal.filter((entry) => entry.type === "attempt_started" && entry.installmentId === installmentId).length + 1;

// The active (lock-holding) attempt for an installment, or null: the latest
// attempt_started with no attempt_outcome bearing its attemptNo. Terminal
// outcomes release the lock; an unresolved outcome KEEPS the lock (recovery
// lane reconciles by hash — this PR never auto-retries those).
export function findActiveAttempt(journal, targetInstallmentId) {
  if (!Array.isArray(journal)) return null;
  let active = null;
  for (const entry of journal) {
    if (entry.installmentId !== targetInstallmentId) continue;
    if (entry.type === "attempt_started") {
      active = entry;
    } else if (entry.type === "attempt_outcome" && active && entry.attemptNo === active.attemptNo) {
      active = entry.status === OUTCOME_LABELS.UNRESOLVED ? active : null;
    }
  }
  return active;
}

export const hasActiveAttempt = (journal, targetInstallmentId) =>
  findActiveAttempt(journal, targetInstallmentId) !== null;

// Returns a NEW journal array plus the bumped seq counter — never mutates.
// The caller persists after setting state; this module does no I/O.
export function appendEntry(journal, journalSeq, entryFields) {
  const seq = nextSeq(journalSeq);
  const entry = {
    seq,
    at: new Date().toISOString(),
    ...entryFields,
  };
  return { journal: [...journal, entry], journalSeq: seq, entry };
}

export function attemptStartedEntry({ journal, journalSeq, plan, sequence, amount, destination, payerAddress, source }) {
  const installmentId = installmentIdFor(plan.id, sequence);
  const base = appendEntry(journal, journalSeq, {
    type: "attempt_started",
    status: ATTEMPT_STARTED_STATUS,
    installmentId,
    planId: plan.id,
    sequence,
    attemptNo: nextAttemptNo(journal, installmentId),
    ...copyEntryFields({ amount, destination, payerAddress, source }, STARTED_FIELDS.filter((f) => !["installmentId", "planId", "sequence", "attemptNo"].includes(f))),
  });
  return base;
}

export function attemptOutcomeEntry({ journal, journalSeq, startedEntry, status, txHash, ledgerResult, error, reason }) {
  return appendEntry(journal, journalSeq, {
    type: "attempt_outcome",
    status,
    installmentId: startedEntry.installmentId,
    attemptNo: startedEntry.attemptNo,
    ...copyEntryFields({ txHash, ledgerResult, error, reason }, OUTCOME_FIELDS.filter((f) => !["installmentId", "attemptNo"].includes(f))),
  });
}

export function dispatchRefusedEntry({ journal, journalSeq, plan, sequence, reason, detail }) {
  const installmentId = sequence === undefined || sequence === null
    ? plan.id
    : installmentIdFor(plan.id, sequence);
  return appendEntry(journal, journalSeq, {
    type: "dispatch_refused",
    status: "refused",
    installmentId,
    ...copyEntryFields({ planId: plan.id, sequence, reason, detail }, REFUSED_FIELDS.filter((f) => f !== "installmentId")),
  });
}

// Recovery: every attempt still in flight when the app died (started, with no
// outcome at all) is relabeled by APPENDING an unresolved outcome — the
// journal is append-only, so the original attempt_started stays as history.
// An attempt that already carries an outcome (including a previous recovery's
// unresolved entry) is skipped: recovery is idempotent under StrictMode's
// double mount. The dispatch LOCK is a different question — findActiveAttempt
// keeps holding through unresolved until the recovery lane reconciles by hash.
export function reconcileInFlightAttempts({ journal, journalSeq }, now = Date.now()) {
  const active = [];
  for (const entry of journal) {
    if (entry.type !== "attempt_started") continue;
    const hasOutcome = journal.some(
      (other) =>
        other.type === "attempt_outcome" &&
        other.installmentId === entry.installmentId &&
        other.attemptNo === entry.attemptNo,
    );
    if (!hasOutcome) active.push(entry);
  }
  let result = { journal, journalSeq, recovered: [] };
  for (const started of active) {
    const appended = attemptOutcomeEntry({
      journal: result.journal,
      journalSeq: result.journalSeq,
      startedEntry: started,
      status: OUTCOME_LABELS.UNRESOLVED,
      reason: "recovered_in_flight",
      txHash: started.txHash,
    });
    result = { ...appended, recovered: [...result.recovered, { installmentId: started.installmentId, attemptNo: started.attemptNo, at: now }] };
  }
  return result;
}

// Prune beyond the cap, never dropping an entry that belongs to an active or
// unresolved attempt — those are the record a restart needs. Newest entries
// survive; the journal is append-only so seq numbers keep growing even when
// old entries leave the array.
export function pruneJournal(journal, cap = JOURNAL_CAP) {
  if (!Array.isArray(journal) || journal.length <= cap) return journal;
  const protectedSeqs = new Set();
  for (const entry of journal) {
    if (entry.type !== "attempt_started") continue;
    const outcome = journal.find(
      (other) =>
        other.type === "attempt_outcome" &&
        other.installmentId === entry.installmentId &&
        other.attemptNo === entry.attemptNo,
    );
    if (!outcome) {
      // Started, never resolved — an active attempt. Its record is load-bearing.
      protectedSeqs.add(entry.seq);
    } else if (outcome.status === OUTCOME_LABELS.UNRESOLVED) {
      // Unresolved: both the started entry and the recovery outcome stay so a
      // restart still sees the lock and the hash to reconcile.
      protectedSeqs.add(entry.seq);
      protectedSeqs.add(outcome.seq);
    }
    // Terminal (validated_success / validated_failure) pairs age out normally.
  }
  // Keep the newest `cap` entries in order, then re-add protected entries that
  // fell outside the window — the cap is soft when protection demands it.
  const kept = [];
  const keptSeqs = new Set();
  for (let i = journal.length - 1; i >= 0 && kept.length < cap; i -= 1) {
    const entry = journal[i];
    kept.unshift(entry);
    keptSeqs.add(entry.seq);
  }
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const entry = journal[i];
    if (keptSeqs.has(entry.seq)) continue;
    if (protectedSeqs.has(entry.seq)) {
      kept.unshift(entry);
      keptSeqs.add(entry.seq);
    }
  }
  return kept;
}
