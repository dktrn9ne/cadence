// Installment domain — pure functions over plan/installment data. No React,
// no storage, no xrpl imports: the durable-storage lane's acceptance table
// (spec art_iD6vSHMR) proves these in unit tests, and the dashboard may call
// them from anywhere without side effects.
//
// Outcome classification reads only what a submit result already carries —
// a hash plus a readable ledger result. It never guesses: a hash whose
// ledger result cannot be read is `unresolved` (needs a hash lookup before
// any retry), and a dispatch that never produced a hash is `failed_no_hash`.
// The journal's terminal labels for one attempt. Only validated_success
// corresponds to a paid installment; relabeling paidCount to honor that is
// the validation lane's change, not this PR's.
export const OUTCOME_LABELS = Object.freeze({
  VALIDATED_SUCCESS: "validated_success",
  VALIDATED_FAILURE: "validated_failure",
  UNRESOLVED: "unresolved",
  FAILED_NO_HASH: "failed_no_hash",
});

// Success result the XRPL reports in meta.TransactionResult (and history
// filters already compare against, e.g. readIncomeProofData).
export const TES_SUCCESS = "tesSUCCESS";

// A restart must never fire an installment the instant the window opens:
// overdue schedules re-enter through this grace window.
export const OVERDUE_GRACE_MS = 60_000;

// Deterministic installment identity: `${planId}:${sequence}`. This module is
// the single source of the format — every dispatch path, journal entry, and
// recovery lookup derives the id from here.
export const installmentIdFor = (planId, sequence) => `${planId}:${sequence}`;

// classifyOutcome({ hash, ledgerResult }) — the only labeling of submit
// results in the codebase.
//   hash + tesSUCCESS            -> validated_success
//   hash + other ledger result   -> validated_failure
//   hash, unreadable/no result   -> unresolved (never auto-retry; reconcile)
//   no hash                      -> failed_no_hash (recorded; nothing advances)
export function classifyOutcome({ hash, ledgerResult } = {}) {
  if (typeof hash !== "string" || hash.trim() === "") {
    return OUTCOME_LABELS.FAILED_NO_HASH;
  }
  if (typeof ledgerResult !== "string" || ledgerResult.trim() === "") {
    return OUTCOME_LABELS.UNRESOLVED;
  }
  return ledgerResult === TES_SUCCESS
    ? OUTCOME_LABELS.VALIDATED_SUCCESS
    : OUTCOME_LABELS.VALIDATED_FAILURE;
}

// Pull the ledger result out of whatever the submit path returned. The three
// submitters return different nestings ({ result } from submitAndWait, raw
// manager responses from wallets) — read only, never guess.
export const readLedgerResult = (result) => {
  const tx = result?.result || result || {};
  return (
    tx.meta?.TransactionResult ??
    tx.result?.meta?.TransactionResult ??
    tx.tx_json?.meta?.TransactionResult ??
    null
  );
};

// Restart grace: an overdue nextRunAt (epoch ms) is pushed past the grace
// window; a future timestamp is kept. Null stays null (unscheduled).
export const clampOverdue = (nextRunAt, now) => {
  if (nextRunAt === null || nextRunAt === undefined) return null;
  const value = Number(nextRunAt);
  if (!Number.isFinite(value) || value > now) return value;
  return now + OVERDUE_GRACE_MS;
};

// Payer-match rule: a plan saved before this PR carries no payerAddress and
// dispatches unchanged ("unpinned legacy plan"). A pinned plan dispatches only
// for the account that authorized it.
export const PAYER_MATCH = Object.freeze({
  UNPINNED: "unpinned",
  MATCH: "match",
  MISMATCH: "mismatch",
});

export function payerMatchesPlan(plan, connectedAddress) {
  // "payer" is the pin the dashboard's stampPlanPayer writes; payerAddress is
  // the spec's name for the same data. Either one binds the plan.
  const pinned = plan?.payerAddress ?? plan?.payer;
  if (typeof pinned !== "string" || pinned.trim() === "") {
    return PAYER_MATCH.UNPINNED;
  }
  return pinned === connectedAddress ? PAYER_MATCH.MATCH : PAYER_MATCH.MISMATCH;
}
