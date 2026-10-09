// Guarded payment dispatch — the single flow every entry point (scheduler
// tick, manual pay, plan auto-start) shares, plus the reconciliation pass the
// app runs on mount and every scheduler tick.
//
// Safety contract (spec art_XPj3pWA4, "What we build" 5–6, locked decisions
// 3–5):
// - One active attempt per installment: the lock check happens INSIDE the
//   dispatch, before anything else, so no entry point can bypass it; the
//   attempt store re-checks atomically as the backstop.
// - awaiting_signature is persisted BEFORE any sign/submit call — a crash
//   mid-submit leaves a durable record.
// - Submission outcomes normalize through normalizeSubmitOutcome; a resolved
//   submission with a hash but no verdict is "submitted" and reconciled by
//   hash; with neither, it is "unresolved" — the response's existence proves
//   nothing and no retry follows.
// - Errors classify through classifySubmitError: provably pre-submission
//   failures (sign rejected, construction) are validated_failure and may
//   reschedule; anything possibly submitted is unresolved and never
//   auto-retries.
// - This module emits events and mutates ONLY attempt records. Plan state
//   (paidCount, nextRunAt, completion) belongs to the caller, which applies it
//   exclusively on validated_success events (locked decision 3).
//
// This module performs no I/O of its own: the attempt store, normalizer,
// error classifier, and reconciler are all injected, so the whole flow is
// provable in tests with fixtures and a mocked ledger lookup (no sockets, no
// secrets).
import {
  OUTCOME_STATES,
  installmentId,
  isFinalFailure,
} from "../domain/paymentOutcome.js";

// A stale no-hash active record (an awaiting_signature orphan left by a
// reload/crash) expires to unresolved — NEVER to validated_failure, which
// could license a retry that double-pays (spec risk R3). The window is long
// enough that a live wallet prompt (Xaman push approval can take minutes)
// never expires mid-flight; and even if it does, the settle helpers are
// state-aware and the transitions stay legal (unresolved accepts both
// validated_success and validated_failure).
export const ACTIVE_EXPIRY_MS = 5 * 60_000;

function requireDeps(deps) {
  const { attemptStore, normalizeSubmitOutcome, classifySubmitError, reconciler } = deps ?? {};
  const missing =
    !attemptStore?.createAttempt ||
    !attemptStore?.updateAttempt ||
    !attemptStore?.getActiveAttempt ||
    !attemptStore?.listAttempts ||
    typeof normalizeSubmitOutcome !== "function" ||
    typeof classifySubmitError !== "function" ||
    typeof reconciler?.reconcileAttempt !== "function";
  if (missing) {
    throw new TypeError(
      "createPaymentDispatch requires { attemptStore: { createAttempt, updateAttempt, getActiveAttempt, listAttempts }, normalizeSubmitOutcome, classifySubmitError, reconciler: { reconcileAttempt } }",
    );
  }
  return { attemptStore, normalizeSubmitOutcome, classifySubmitError, reconciler };
}

export function createPaymentDispatch(deps) {
  const { attemptStore, normalizeSubmitOutcome, classifySubmitError, reconciler } =
    requireDeps(deps);

  // A resolved submission with no readable ledger verdict and no hash:
  // response lost — blocked, surfaced, never a blind retry.
  function holdUnresolved(record, context, emit) {
    if (record.state !== OUTCOME_STATES.unresolved) {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.unresolved);
    }
    emit({ type: "unresolved", record, label: context.label });
    return record;
  }

  // Reconciles a submitted (hash-bearing) record and settles on the verdict.
  // Lookup failures other than txnNotFound rethrow from the reconciler; the
  // attempt stays unresolved and the error is surfaced, never classified as
  // an outcome.
  async function reconcileAndSettle(record, context, emit) {
    let result;
    try {
      result = await reconciler.reconcileAttempt(record);
    } catch (error) {
      emit({
        type: "unresolved",
        record,
        label: context.label,
        reason: "ledger lookup failed",
      });
      return attemptStore.updateAttempt(record.id, OUTCOME_STATES.unresolved);
    }
    if (result.anomaly) {
      emit({ type: "anomaly", record, label: context.label, anomaly: result.anomaly });
    }
    if (result.next === OUTCOME_STATES.validated_success) {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.validated_success, {
        ledgerResult: result.ledgerResult,
      });
      emit({ type: "validated_success", record, label: context.label });
      return record;
    }
    if (result.next === OUTCOME_STATES.validated_failure) {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.validated_failure, {
        ledgerResult: result.ledgerResult,
      });
      emit({
        type: "validated_failure",
        record,
        label: context.label,
        reason: result.ledgerResult,
      });
      return record;
    }
    return holdUnresolved(record, context, emit);
  }

  // A resolved submission with a readable ledger verdict: the desktop
  // submitAndWait receipt. The response IS this attempt's own transaction
  // (signed deterministically by the local wallet), so no identity check is
  // needed — unlike hash lookups, there is no wrong-row risk.
  function settleFromReceipt(record, receipt, context, emit) {
    const normalized = normalizeSubmitOutcome(receipt);
    if (normalized.ledgerResult) {
      if (normalized.ledgerResult === "tesSUCCESS") {
        // awaiting_signature -> validated_success is illegal in the machine;
        // route through submitted. (If the record expired to unresolved
        // mid-flight, unresolved -> validated_success is legal directly.)
        if (record.state === OUTCOME_STATES.awaiting_signature) {
          record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.submitted, {
            hash: normalized.hash,
          });
        }
        record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.validated_success, {
          ledgerResult: normalized.ledgerResult,
        });
        emit({ type: "validated_success", record, label: context.label });
        return record;
      }
      if (record.state === OUTCOME_STATES.awaiting_signature) {
        record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.submitted, {
          hash: normalized.hash,
        });
      }
      if (isFinalFailure(normalized.ledgerResult)) {
        record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.validated_failure, {
          ledgerResult: normalized.ledgerResult,
        });
        emit({
          type: "validated_failure",
          record,
          label: context.label,
          reason: normalized.ledgerResult,
        });
        return record;
      }
      // A verdict that is neither tesSUCCESS nor a final failure code —
      // never guessed; reconcile by hash like any other inconclusive receipt.
      if (normalized.hash && record.state !== OUTCOME_STATES.unresolved) {
        record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.submitted, {
          hash: normalized.hash,
        });
        emit({ type: "submitted", record, label: context.label });
        return reconcileAndSettle(record, context, emit);
      }
      return holdUnresolved(record, context, emit);
    }
    if (normalized.hash) {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.submitted, {
        hash: normalized.hash,
      });
      emit({ type: "submitted", record, label: context.label });
      return reconcileAndSettle(record, context, emit);
    }
    return holdUnresolved(record, context, emit);
  }

  // A thrown submission: classify by provability. sign_rejected/construction
  // are provably pre-submission (validated_failure, retry-safe); network and
  // unknown errors are possibly-landed (unresolved, never auto-retried).
  function settleFromError(record, error, context, emit) {
    const errorClass = classifySubmitError(error);
    const reason = error?.message || "submission failed";
    if (errorClass === "sign_rejected" || errorClass === "construction") {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.validated_failure, {
        errorClass,
      });
      emit({
        type: "validated_failure",
        record,
        label: context.label,
        reason,
        errorClass,
      });
      return record;
    }
    if (record.state !== OUTCOME_STATES.unresolved) {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.unresolved, {
        errorClass,
      });
    }
    emit({ type: "unresolved", record, label: context.label, reason });
    return record;
  }

  // The guarded dispatch. plan: { id, paidCount } (the person snapshot);
  // context: { source, label, payer, destination, amount, currency, issuer,
  // sourceTag, submit }; emit: the caller's event handler. Resolves with the
  // final attempt record, or null when the dispatch was refused.
  async function dispatch(plan, context, emit) {
    if (typeof emit !== "function") {
      throw new TypeError("dispatch requires an emit(event) handler");
    }
    const sequence = Number(plan?.paidCount || 0);
    const instId = installmentId(plan.id, sequence);

    // The per-installment lock, checked inside the single dispatch every
    // entry point shares. Refusal is an event, not a throw — a concurrent
    // dispatch is an expected, surfaced condition (no history spam).
    const active = attemptStore.getActiveAttempt(instId);
    if (active) {
      emit({ type: "lock_refused", record: active, label: context.label, source: context.source });
      return null;
    }

    let record;
    try {
      record = attemptStore.createAttempt({
        planId: plan.id,
        sequence,
        source: context.source,
        payer: context.payer,
        destination: context.destination,
        amount: context.amount,
        currency: context.currency,
        issuer: context.issuer,
        sourceTag: context.sourceTag,
      });
    } catch (error) {
      // The store re-checks the lock atomically — a lost race surfaces as a
      // refusal. Any other store failure is fail-closed: the payment blocks
      // BEFORE anything is built or submitted (an untracked payment is how
      // double-pays happen), surfaced through the store_failed event.
      const raced = attemptStore.getActiveAttempt(instId);
      if (raced) {
        emit({ type: "lock_refused", record: raced, label: context.label, source: context.source });
        return null;
      }
      emit({ type: "store_failed", label: context.label, planId: plan.id, sequence, error });
      return null;
    }

    // Persisted before ANY sign/submit call: a crash from here on leaves a
    // durable awaiting_signature record the reconciliation pass can expire.
    try {
      record = attemptStore.updateAttempt(record.id, OUTCOME_STATES.awaiting_signature);
    } catch (error) {
      emit({ type: "store_failed", label: context.label, planId: plan.id, sequence, error });
      return null;
    }
    emit({ type: "awaiting_signature", record, label: context.label });

    let receipt;
    try {
      receipt = await context.submit();
    } catch (error) {
      return settleFromError(record, error, context, emit);
    }
    return settleFromReceipt(record, receipt, context, emit);
  }

  // The reconciliation pass — the app runs it once on mount and on every
  // scheduler tick. Two jobs, in order:
  // 1. Expire stale no-hash awaiting_signature records to unresolved (never
  //    validated_failure — see ACTIVE_EXPIRY_MS).
  // 2. Reconcile unresolved attempts that carry a hash. Un-hashed unresolved
  //    attempts have nothing to look up — they stay blocked and surfaced.
  // Each record is re-read immediately before its transition: an await point
  // may have let a concurrent dispatch settle it, and the transition table
  // makes any double-apply loud.
  async function runReconciliationPass(emit) {
    if (typeof emit !== "function") {
      throw new TypeError("runReconciliationPass requires an emit(event) handler");
    }
    const now = Date.now();
    for (const record of attemptStore.listAttempts()) {
      if (
        record.state === OUTCOME_STATES.awaiting_signature &&
        !record.hash &&
        now - record.updatedAt > ACTIVE_EXPIRY_MS
      ) {
        const expired = attemptStore.updateAttempt(record.id, OUTCOME_STATES.unresolved);
        emit({ type: "expired_to_unresolved", record: expired });
      }
    }

    const unresolved = attemptStore
      .listAttempts()
      .filter((r) => r.state === OUTCOME_STATES.unresolved && r.hash);
    for (const record of unresolved) {
      const fresh = attemptStore.listAttempts().find((r) => r.id === record.id);
      if (!fresh || fresh.state !== OUTCOME_STATES.unresolved) continue;
      let result;
      try {
        result = await reconciler.reconcileAttempt(fresh);
      } catch (error) {
        emit({
          type: "reconcile_failed",
          record: fresh,
          reason: String(error?.message ?? error),
        });
        continue;
      }
      if (result.anomaly) {
        emit({ type: "anomaly", record: fresh, anomaly: result.anomaly });
      }
      if (result.next === OUTCOME_STATES.unresolved) continue;
      const latest = attemptStore.listAttempts().find((r) => r.id === record.id);
      if (!latest || latest.state !== OUTCOME_STATES.unresolved) continue;
      const updated = attemptStore.updateAttempt(latest.id, result.next, {
        ledgerResult: result.ledgerResult,
      });
      emit({ type: result.next, record: updated });
    }
  }

  return { dispatch, runReconciliationPass };
}
