// The single guarded door for installment dispatch (PR 04 wave 3; spec-gap
// fixes per audit art_FIvT05e6).
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
//      map is memory, this guard is durable. The guard reads the NEWEST
//      attempt per installment; earlier attempts are history.
//   5. Only `validated_success` — `meta.TransactionResult === "tesSUCCESS"`
//      on a transaction whose IDENTITY matches the attempt (payer,
//      destination, exact amount string, currency, issuer, source tag) —
//      advances `paidCount`, exactly once. Failures and unresolved outcomes
//      record the attempt and never advance.
//   6. Fail-closed store: the attempt record must land durably BEFORE the
//      submit call — a storage failure blocks the payment rather than
//      submitting an untracked attempt (an untracked payment is how
//      double-pays happen).
//   7. Possibly-submitted outcomes never retry: errors that do not PROVE
//      nothing was submitted park in `unresolved`; only a ledger lookup by
//      transaction hash can release them. Retry is always a fresh,
//      user-initiated attempt.
//
// No secrets pass through here: attempt records are allowlisted by planState.

import {
  beginInstallment,
  classifySubmitError,
  dispatchBlockReason,
  installmentId,
  markSubmitted,
  markUnresolved,
  settleRejected,
  settleValidated,
} from "../domain/installment.js";
import { getFrequencyMs, getSchedule } from "../domain/schedule.js";
import { latestAttemptFor, recordAttempt } from "../storage/planState.js";
import {
  attemptIdentityMatches,
  classifyTransactionResult,
  OUTCOMES,
  lookupTransaction,
} from "./xrplLedger.js";

export function createInstallmentDispatcher({
  // Freshest committed plans array — the dispatcher reads CURRENT plan state,
  // never the caller's possibly-stale snapshot.
  getPlans,
  // Single-writer commit: replaces app state and keeps the mirror in sync.
  setPlans,
  // (plan, amount) => Promise<{ result, hash }> — the dashboard's existing
  // submitter selection (XRPL Connect vs local signing).
  submit,
  // (hash, expected) => Promise<{ outcome, tx?, anomaly? }> —
  // reconcile-by-hash; injected for tests, defaults to the real ledger lookup.
  reconcile = lookupTransaction,
  now = () => Date.now(),
  // Claim set lives in a ref owned by the caller so it survives re-renders
  // (including wallet-state changes) for the lifetime of the mount.
  claims = new Set(),
}) {
  // Persist one attempt transition durably (planState writes immediately, so
  // the hash survives the reload it exists to be reconciled after) and commit
  // it into app state. Returns whether the record actually landed — callers
  // decide what a lost write means for safety.
  const persistAttempt = (planId, attempt) => {
    const plans = getPlans();
    const { plans: next, persisted } = recordAttempt(plans, planId, attempt);
    if (next !== plans) setPlans(next);
    return persisted;
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

  async function dispatchInstallment(person, sequence, source, { amount = "", payer = "" } = {}) {
    const key = installmentId(person.id, sequence);

    // --- synchronous gate prologue: no await before the claim is taken ------
    if (claims.has(key)) return { dispatched: false, reason: "already-in-flight" };

    const current = getPlans().find((plan) => plan?.id === person.id) || person;

    if (current.active === false) return { dispatched: false, reason: "plan-paused" };
    if (current.catchUpPending === true) return { dispatched: false, reason: "needs-approval" };

    // The newest attempt for this installment carries the durable guard; a
    // validated_failure history row never unblocks a live unresolved one.
    const blocked = dispatchBlockReason(latestAttemptFor(current, sequence));
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

    // Payment identity for this attempt: the account that will actually sign
    // (the payer guard has already proven plan.payer, when set, equals it),
    // the plan's destination, and the exact decimal amount string. Records
    // persist it so a ledger lookup can verify a transaction IS this payment.
    const expected = {
      payer: payer || current.payer || "",
      destination: current.destination ?? current.address ?? "",
      amount,
    };

    claims.add(key);
    try {
      // Attempts number upward per installment: a retry writes its own record
      // and never overwrites the evidence of the attempt before it.
      const attemptNo = (Number(latestAttemptFor(current, sequence)?.attemptNo) || 0) + 1;
      let attempt = {
        ...beginInstallment(current, sequence, now()),
        amount,
        attemptNo,
        payer: expected.payer,
        destination: expected.destination,
      };

      // Fail-closed store (audit violation 3): the awaiting_signature record
      // must land durably BEFORE any sign/submit call. A lost write means a
      // submission could not be reconciled after a reload — block instead.
      if (!persistAttempt(person.id, attempt)) {
        return {
          dispatched: false,
          reason: "store-failed",
          error: new Error("The attempt record could not be persisted — the payment was not submitted."),
        };
      }

      // --- build + submit (wallet prompt, or local sign + submitAndWait) ----
      let response;
      try {
        response = await submit(current, amount);
      } catch (error) {
        // Classify by PROVABILITY (audit violation 2): a rejected signature or
        // a construction failure proves nothing was submitted — a failed,
        // retry-safe attempt. Anything else (timeout, transport drop, unknown
        // shape) may have landed on-ledger: park it unresolved, where only a
        // ledger lookup by hash can release it. Never a silent retry.
        const errorClass = classifySubmitError(error);
        if (errorClass === "sign_rejected" || errorClass === "construction") {
          attempt = settleRejected(attempt);
          persistAttempt(person.id, attempt);
          if (source === "scheduled") unschedule(person.id);
          return { dispatched: true, outcome: "validated_failure", error, hash: null, failureReason: error?.message || "The payment could not be built or submitted." };
        }
        attempt = markUnresolved(attempt, null, now());
        persistAttempt(person.id, attempt);
        return {
          dispatched: true,
          outcome: "unresolved",
          hash: null,
          anomaly: null,
          failureReason: error?.message || "The submission outcome is unknown — reconciling before any retry.",
        };
      }

      const result = response?.result ?? {};
      const inner = result?.result || result || {};
      const txHash = response?.hash || inner?.hash || null;

      if (!txHash) {
        // The wallet resolved without a usable hash: the response's existence
        // proves nothing about the ledger. The submission may have gone
        // through — park it unresolved (audit violation 2); only a ledger
        // lookup could classify it, and there is no hash to look up.
        attempt = markUnresolved(attempt, null, now());
        persistAttempt(person.id, attempt);
        return {
          dispatched: true,
          outcome: "unresolved",
          hash: null,
          anomaly: null,
          failureReason: "The wallet resolved without a usable confirmation hash.",
        };
      }

      // Hash captured — persist it before classifying so the reload-mid-flight
      // window keeps its reconciliation anchor. A lost write here degrades the
      // attempt's durability; surface it, never swallow it.
      let storeDegraded = false;
      attempt = markSubmitted(attempt, txHash, now());
      if (!persistAttempt(person.id, attempt)) storeDegraded = true;

      // Outcome classification. When the receipt carries the transaction body
      // (local submitAndWait does), identity is verified directly and the
      // ledger's own meta decides. A bodyless receipt (adapter shapes) or a
      // receipt without a readable verdict is never trusted on its own — one
      // lookup by hash reconciles it, identity-checked, and whatever the
      // ledger cannot answer stays unresolved.
      const meta = result?.result?.meta ?? result?.meta ?? null;
      const hasBody =
        typeof inner?.Account === "string" &&
        typeof inner?.Destination === "string" &&
        inner?.Amount !== null &&
        typeof inner?.Amount === "object";
      const identityOk = hasBody ? attemptIdentityMatches(inner, expected) : null;

      let settled;
      let anomaly = null;
      if (identityOk === false) {
        // The receipt describes someone else's payment — its verdict must
        // classify nothing. Park unresolved and surface the anomaly.
        anomaly = "identity_mismatch";
        settled = markUnresolved(attempt, txHash, now());
      } else {
        const verdict = identityOk === true ? classifyTransactionResult({ meta }) : null;
        if (verdict === OUTCOMES.SUCCESS) {
          settled = settleValidated(attempt, meta);
        } else if (verdict === OUTCOMES.FAILURE) {
          settled = settleValidated(attempt, meta); // ledger answered, not success
        } else {
          const lookup = await reconcile(txHash, expected);
          if (lookup?.anomaly) {
            anomaly = lookup.anomaly;
            settled = markUnresolved(attempt, txHash, now());
          } else if (lookup?.outcome === OUTCOMES.SUCCESS) {
            settled = settleValidated(attempt, { TransactionResult: "tesSUCCESS" });
          } else if (lookup?.outcome === OUTCOMES.FAILURE) {
            settled = settleRejected(attempt);
          } else {
            settled = markUnresolved(attempt, txHash, now());
          }
        }
      }
      if (!persistAttempt(person.id, settled)) storeDegraded = true;

      if (settled.status !== "validated_success") {
        if (settled.status === "validated_failure" && source === "scheduled") {
          unschedule(person.id);
        }
        return {
          dispatched: true,
          outcome: settled.status,
          hash: txHash,
          anomaly,
          storeDegraded,
          // The ledger's own verdict (tec*/tef*/tem*), for an honest
          // failed-attempt row — a reconciled failure without a readable code
          // falls back to the generic ledger message in the UI.
          failureReason: meta?.TransactionResult
            ? `The ledger rejected the payment (${meta.TransactionResult}).`
            : "The payment did not succeed on the ledger.",
        };
      }

      // THE ONLY ADVANCE — validated_success on an identity-matched
      // transaction, exactly once per attempt.
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
      return { dispatched: true, outcome: "validated_success", hash: txHash, nextPaidCount, complete, storeDegraded };
    } finally {
      claims.delete(key);
    }
  }

  return { dispatchInstallment, claims };
}
