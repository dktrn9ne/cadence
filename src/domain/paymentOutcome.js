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
