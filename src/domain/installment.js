// Installment state machine — the safety core of PR 04 scheduler recovery.
//
// Pure functions only: no I/O, no clocks, no wallet access, no persistence.
// The dashboard owns I/O and timing; this module owns the rules. Every
// function returns a new attempt record and never mutates its input.
//
// Lifecycle:
//
//   scheduled -> awaiting_signature -> submitted -> validated_success
//                                               |-> validated_failure
//                                               |-> unresolved
//
// Two rules do the safety work:
//   1. Only `settleValidated` can produce `validated_success`, and only a
//      ledger-verified `meta.TransactionResult === "tesSUCCESS"` produces it.
//      The caller advances `paidCount` exactly once per attempt that gains
//      that status — no other outcome, no other path.
//   2. An `unresolved` attempt leaves its installment blocked for dispatch
//      until a ledger lookup by transaction hash re-classifies it (via
//      `settleValidated`/`settleRejected`). It never exits by timer and
//      never by a fresh submission.
//
// Attempt records carry public data only: sequence, status, hash,
// submittedAt. Nothing here accepts, stores, or returns mnemonic, seed,
// private key, or signed-blob material.

// Deterministic per-installment identity — stable across reloads because it
// derives from plan identity and sequence alone, never from list indexes or
// creation time. Every claim, attempt record, and reconciliation is keyed by
// this id.
export function installmentId(planId, sequence) {
  return `${planId}:${sequence}`;
}

// scheduled -> awaiting_signature. The caller must already hold the dispatch
// claim for `installmentId(plan.id, sequence)` — one active attempt per
// installment, shared by the scheduler tick, the manual button, and the
// start-plan path.
//
// `plan` stays in the pinned dispatch interface so call sites read uniformly
// and display-only fields can be stamped later without a signature change.
// The record itself is deliberately plan-shape agnostic: deriving the
// installment amount here would couple this module to the legacy float
// schedule math, which is out of scope for PR 04.
export function beginInstallment(plan, sequence, now) {
  return { sequence, status: "awaiting_signature", hash: null, submittedAt: now };
}

// awaiting_signature -> submitted. Hash captured from the wallet or
// `submitAndWait`; the outcome is NOT yet validated.
export function markSubmitted(attempt, hash, now) {
  return { ...attempt, status: "submitted", hash, submittedAt: now };
}

// THE ONLY ADVANCE IN THE SYSTEM — and the only producer of
// `validated_success`. `meta` is the ledger meta extracted by the caller
// (`result?.result?.meta ?? result?.meta`), either from the submit result or
// from a tx-by-hash reconciliation. Anything other than tesSUCCESS —
// tec*/tef*/tem* ledger results, or a missing meta from a hash-less wallet
// rejection — is a failed attempt, never an advance.
//
// Meta-driven by design so reconciliation can re-enter classification from
// `unresolved`; callers settle only attempts that reached `submitted`.
export function settleValidated(attempt, meta) {
  if (meta?.TransactionResult !== "tesSUCCESS") return settleRejected(attempt, meta);
  return { ...attempt, status: "validated_success" };
}

// submitted -> validated_failure. A tec*/tef*/tem* ledger result, or a
// hash-less wallet rejection / construction failure (meta null). Records a
// failed attempt and NEVER advances the plan; a hash that exists (on-ledger
// failure) is preserved as evidence. Retry is a fresh, user-visible attempt —
// never an automatic one.
export function settleRejected(attempt, meta) {
  return { ...attempt, status: "validated_failure" };
}

// submitted -> unresolved. The submission has a hash but its outcome is
// unknown (reload, timeout, disconnect). The only exit is a ledger lookup by
// `hash`; the dispatcher must block new dispatch for this installment while
// the status stands.
export function markUnresolved(attempt, hash, now) {
  return { ...attempt, status: "unresolved", hash, submittedAt: now };
}

// Attempt-level dispatch guard, consumed by the guarded dispatcher alongside
// its own plan-level checks (paused plans, catch-up approval, the in-flight
// claim set). Returns a reason string when the installment must not be
// dispatched, or null when a dispatch claim may be taken.
//
// A persisted attempt survives reloads even though the in-memory claim set
// does not — this guard is what keeps an in-flight, unresolved, or already
// validated installment from being re-sent after a restart. Unrecognized
// statuses fail closed.
export function dispatchBlockReason(attempt) {
  if (attempt == null) return null; // fresh installment, nothing in flight
  switch (attempt.status) {
    case "awaiting_signature":
    case "submitted":
      return "already-in-flight";
    case "unresolved":
      return "unresolved-attempt";
    case "validated_success":
      return "already-validated"; // re-sending it is the double-pay path
    case "validated_failure":
      return null; // terminal failure: a fresh, user-visible retry may proceed
    default:
      return "unknown-attempt-state";
  }
}
