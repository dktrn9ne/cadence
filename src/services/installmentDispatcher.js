// The single guarded door for installment dispatch (PR 04 wave 3).
//
// Every entry point — the scheduler tick, the "Pay one installment" button,
// and the start-plan timer — routes through `dispatchInstallment`. It composes
// the three PR 04 modules:
//
//   - src/domain/installment.js    state transitions + attempt-level guard
//   - src/storage/planState.js    durable attempt records (immediate persist)
//   - src/services/xrplLedger.js  reconcile-by-hash for unknown outcomes
//
// Safety rules enforced here, in order:
//   1. One active attempt per installment: an in-memory claim map keyed by the
//      deterministic `${planId}:${sequence}` id is claimed synchronously before
//      any await, so no two entry points can interleave. A second entry point
//      on the same installment gets `{ dispatched: false, reason:
//      "already-in-flight" }`.
//   2. Paused plans refuse dispatch — manually or on a tick.
//   3. Catch-up approval: a plan restored with missed windows waits for an
//      explicit approval (the recovery flow owns setting `catchUpPending`).
//   4. A persisted attempt blocks its installment while it is in flight,
//      unresolved, or already validated (see `dispatchBlockReason`) — the claim
//      map is memory, this guard is durable.
//   5. Only `validated_success` — `meta.TransactionResult === "tesSUCCESS"`,
//      directly from the submit response or re-entered via a ledger lookup by
//      hash — advances `paidCount`, exactly once. Failures and unresolved
//      outcomes record the attempt and never advance; failures from scheduled
//      sends unschedule the window instead of silently retrying it. Retry is
//      always a fresh, user-initiated attempt.
//
// No secrets pass through here: attempt records are allowlisted by planState.

import {
  beginInstallment,
  dispatchBlockReason,
  installmentId,
  markSubmitted,
  markUnresolved,
  settleRejected,
  settleValidated,
} from "../domain/installment.js";
import { getFrequencyMs, getSchedule } from "../domain/schedule.js";
import { recordAttempt } from "../storage/planState.js";
import { classifyTransactionResult, OUTCOMES, lookupTransaction } from "./xrplLedger.js";

export function createInstallmentDispatcher({
  // Freshest committed plans array — the dispatcher reads CURRENT plan state,
  // never the caller's possibly-stale snapshot.
  getPlans,
  // Single-writer commit: replaces app state and keeps the mirror in sync.
  setPlans,
  // (plan, amount) => Promise<{ result, hash }> — the dashboard's existing
  // submitter selection (XRPL Connect vs local signing).
  submit,
  // (hash) => Promise<{ outcome }> — reconcile-by-hash; injected for tests,
  // defaults to the real ledger lookup.
  reconcile = lookupTransaction,
  now = () => Date.now(),
  // Claim set lives in a ref owned by the caller so it survives re-renders
  // (including wallet-state changes) for the lifetime of the mount.
  claims = new Set(),
}) {
  // Persist one attempt transition durably (planState writes immediately, so
  // the hash survives the reload it exists to be reconciled after) and commit
  // it into app state.
  const persistAttempt = (planId, attempt) => {
    const plans = getPlans();
    const next = recordAttempt(plans, planId, attempt);
    if (next !== plans) setPlans(next);
  };

  // A scheduled send that ends without a validated success must not leave its
  // window in the past — the tick would treat that as a retry signal. Clear
  // the schedule; the failure is surfaced and retry is a user decision.
  const unschedule = (planId) => {
    const next = getPlans().map((plan) =>
      plan?.id === planId ? { ...plan, nextRunAt: null } : plan,
    );
    setPlans(next);
  };

  async function dispatchInstallment(person, sequence, source, { amount = "" } = {}) {
    const key = installmentId(person.id, sequence);

    // --- synchronous gate prologue: no await before the claim is taken ------
    if (claims.has(key)) return { dispatched: false, reason: "already-in-flight" };

    const current = getPlans().find((plan) => plan?.id === person.id) || person;

    if (current.active === false) return { dispatched: false, reason: "plan-paused" };
    if (current.catchUpPending === true) return { dispatched: false, reason: "needs-approval" };

    const blocked = dispatchBlockReason(current.attempts?.[key]);
    if (blocked) return { dispatched: false, reason: blocked };

    const paidCount = Number(current.paidCount || 0);
    if (paidCount >= getSchedule(current).payments) {
      // Plan complete: deactivate and clear the schedule so no window fires.
      setPlans(
        getPlans().map((plan) =>
          plan?.id === person.id ? { ...plan, active: false, nextRunAt: null } : plan,
        ),
      );
      return { dispatched: false, reason: "plan-complete" };
    }

    claims.add(key);
    try {
      let attempt = { ...beginInstallment(current, sequence, now()), amount };
      persistAttempt(person.id, attempt);

      // --- build + submit (wallet prompt, or local sign + submitAndWait) ----
      let response;
      try {
        response = await submit(current, amount);
      } catch (error) {
        // Construction or network failure: no hash exists by definition, so
        // there is nothing to reconcile — a failed attempt, never an advance,
        // never a silent retry.
        attempt = settleRejected(attempt);
        persistAttempt(person.id, attempt);
        if (source === "scheduled") unschedule(person.id);
        return { dispatched: true, outcome: "validated_failure", error, hash: null };
      }

      const result = response?.result ?? {};
      const inner = result?.result || result || {};
      const txHash = response?.hash || inner?.hash || null;

      if (!txHash) {
        // The wallet resolved without a usable hash: a rejection or unusable
        // response. Record the failed attempt; the plan never advances.
        attempt = settleRejected(attempt);
        persistAttempt(person.id, attempt);
        if (source === "scheduled") unschedule(person.id);
        return { dispatched: true, outcome: "validated_failure", error: null, hash: null };
      }

      // Hash captured — persist it before classifying so the reload-mid-flight
      // window keeps its reconciliation anchor.
      attempt = markSubmitted(attempt, txHash, now());
      persistAttempt(person.id, attempt);

      // Outcome classification. The ledger's own meta decides; a hash without
      // a readable verdict is never guessed — one lookup by hash reconciles
      // it, and whatever the ledger cannot answer stays unresolved.
      const meta = result?.result?.meta ?? result?.meta ?? null;
      const verdict = classifyTransactionResult({ meta });
      let settled;
      if (verdict === OUTCOMES.SUCCESS) {
        settled = settleValidated(attempt, meta);
      } else if (verdict === OUTCOMES.FAILURE) {
        settled = settleValidated(attempt, meta); // ledger answered, not success
      } else {
        const lookup = await reconcile(txHash);
        if (lookup?.outcome === OUTCOMES.SUCCESS) {
          settled = settleValidated(attempt, { TransactionResult: "tesSUCCESS" });
        } else if (lookup?.outcome === OUTCOMES.FAILURE) {
          settled = settleRejected(attempt);
        } else {
          settled = markUnresolved(attempt, txHash, now());
        }
      }
      persistAttempt(person.id, settled);

      if (settled.status !== "validated_success") {
        if (settled.status === "validated_failure" && source === "scheduled") {
          unschedule(person.id);
        }
        return { dispatched: true, outcome: settled.status, hash: txHash };
      }

      // THE ONLY ADVANCE — validated_success, exactly once per attempt.
      const nextPaidCount = paidCount + 1;
      const complete = nextPaidCount >= getSchedule(current).payments;
      setPlans(
        getPlans().map((plan) =>
          plan?.id === person.id
            ? {
                ...plan,
                paidCount: nextPaidCount,
                active: complete ? false : plan.active,
                nextRunAt: complete ? null : now() + getFrequencyMs(plan),
              }
            : plan,
        ),
      );
      return { dispatched: true, outcome: "validated_success", hash: txHash, nextPaidCount, complete };
    } finally {
      claims.delete(key);
    }
  }

  return { dispatchInstallment, claims };
}
