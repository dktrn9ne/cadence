// Installment outcome machine — the single source of truth for what a payment
// attempt can be and when it may move. Pure data and pure functions: no I/O,
// no wallet, no ledger client, so the machine is provable in unit tests.
//
// Safety contract (spec art_XPj3pWA4, locked decisions 2–5):
// - installmentId is deterministic: `${planId}:${sequence}`, sequence derived
//   from paidCount at dispatch time.
// - Only validated_success may advance a plan — callers enforce that, and this
//   transition table is what makes every other path unable to reach it.
// - A no-hash failure before submission is validated_failure (retry-safe);
//   anything possibly submitted is unresolved and never auto-retries.
// - ACTIVE_STATES is the per-installment lock set; terminal states release it.

export const OUTCOME_STATES = Object.freeze({
  scheduled: "scheduled",
  awaiting_signature: "awaiting_signature",
  submitted: "submitted",
  unresolved: "unresolved",
  validated_success: "validated_success",
  validated_failure: "validated_failure",
});

// States that hold the per-installment lock. scheduled does not: the record
// exists but dispatch has not started. Terminal states release it.
export const ACTIVE_STATES = Object.freeze(
  new Set(["awaiting_signature", "submitted", "unresolved"]),
);

export const isActiveState = (state) => ACTIVE_STATES.has(state);

// Deterministic installment identity: plan id + 0-based installment sequence.
export const installmentId = (planId, sequence) => `${planId}:${sequence}`;

// Exactly the legal moves in the spec's state model. Expiry moves a stale
// awaiting_signature/submitted record to unresolved — never to
// validated_failure, which could license a double-pay retry. Reconciliation
// may resolve an unresolved record in either terminal direction.
const TRANSITIONS = Object.freeze({
  scheduled: ["awaiting_signature"],
  awaiting_signature: ["submitted", "unresolved", "validated_failure"],
  submitted: ["unresolved", "validated_success", "validated_failure"],
  unresolved: ["validated_success", "validated_failure"],
  validated_success: [],
  validated_failure: [],
});

function canTransition(state, nextState) {
  return Boolean(TRANSITIONS[state]?.includes(nextState));
}

// Returns a new record with the transition applied; throws on any move the
// table does not list. A wrong transition in payment code must be loud in
// tests, not quiet in production — the input record is never mutated.
export function transition(record, nextState, patch = {}) {
  if (!canTransition(record?.state, nextState)) {
    throw new Error(
      `Illegal outcome transition ${record?.state} -> ${nextState} (${record?.installmentId ?? "unknown installment"})`,
    );
  }
  return { ...record, ...patch, state: nextState, updatedAt: Date.now() };
}

// Final failure classes on XRPL: tec* (claim failure), tef* (terminal local
// failure), tel* (local failure), tem* (malformed) — the transaction reached a
// final non-success state. tesSUCCESS is the only success code; any other
// verdict is unresolved (never guessed). Canonical definition — the ledger
// reconciler and the receipt classifier both read this, so the two paths can
// never disagree about what counts as a final failure.
const FINAL_FAILURE = /^te[cflm]/i;

export const isFinalFailure = (verdict) =>
  typeof verdict === "string" && FINAL_FAILURE.test(verdict);

// Classifies a submission error into the store's ERROR_CLASSES. The split is
// provability, not convenience — the question is always "can we prove nothing
// was submitted?":
// - "sign_rejected" — the wallet refused to sign (XRPL Connect's dedicated
//   SIGN_REJECTED code, verified in the installed @textrp/xrpl-connect 0.6.0
//   bundle: WalletError { name: "WalletError", code: "SIGN_REJECTED",
//   message: "Transaction signing was rejected by the user." }) or the message
//   is explicit user rejection. No signature -> no submission -> retry-safe.
// - "construction" — a provably pre-submission precondition failure
//   (NOT_CONNECTED / "Connect an XRPL wallet first.").
// - "network" (the default) — anything else, including SIGN_FAILED wrappers,
//   sign timeouts, and popup closes: none of those PROVE nothing was
//   submitted, so the attempt is possibly-landed and must go unresolved, never
//   auto-retried (spec locked decision 4).
const SIGN_REJECTED_MESSAGE = /user rejected|rejected by the user|payload rejected/i;
const CONSTRUCTION_MESSAGE = /connect an xrpl wallet first/i;

export function classifySubmitError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "SIGN_REJECTED") return "sign_rejected";
  if (code === "NOT_CONNECTED") return "construction";
  const message = String(error?.message ?? "");
  if (SIGN_REJECTED_MESSAGE.test(message)) return "sign_rejected";
  if (CONSTRUCTION_MESSAGE.test(message)) return "construction";
  return "network";
}

// Pure plan advancement — the ONLY way a plan's paid count moves. The event
// handler in the dashboard applies this on validated_success; every other
// outcome leaves the plan untouched. Guarded on sequence: a success event for
// an installment the plan has already moved past never corrupts the count.
export function applyValidatedSuccess(person, { sequence, payments, frequencyMs, now = Date.now() }) {
  const paidCount = Number(person?.paidCount || 0);
  if (paidCount !== sequence) return person;
  const nextPaidCount = paidCount + 1;
  const complete = nextPaidCount >= payments;
  return {
    ...person,
    paidCount: nextPaidCount,
    active: complete ? false : person.active,
    nextRunAt: complete ? null : now + frequencyMs,
  };
}

// Pure retry deferral for validated_failure: pushes the SAME installment's
// retry out by retryDelayMs without touching paidCount (locked decision 3 —
// the count and the next-installment schedule move only on validated_success).
// max() keeps a later existing nextRunAt rather than pulling it earlier.
export function applyValidatedFailureRetry(person, { now = Date.now(), retryDelayMs = 60_000 }) {
  const current = Number(person?.nextRunAt) || 0;
  return { ...person, nextRunAt: Math.max(current, now + retryDelayMs) };
}
