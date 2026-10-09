// Ledger reconciliation: a known transaction hash becomes a validated
// verdict — or the attempt stays unresolved. Pure classification over an
// injected lookup; this module never constructs a client or opens a socket.
// Production wiring supplies fetchTransaction; tests supply a mock.
//
// fetchTransaction contract: given a transaction hash, resolve with the
// ledger's transaction object — the .result of a
// client.request({ command: "tx", transaction: hash }) response — or reject.
// Rejections carry the rippled error payload on .data (verified below).
//
// Safety contract (spec art_XPj3pWA4, locked decision 3): tesSUCCESS plus an
// identity match is the ONLY success this module can report. Everything else
// is a final failure or unresolved — unresolved never releases the attempt
// lock and never licenses a retry.

import { OUTCOME_STATES, isFinalFailure } from "../domain/paymentOutcome.js";

// A `tx` lookup for a transaction that is not in a validated ledger yet
// rejects with a RippledError whose .data is the rippled error response —
// error.data.error === "txnNotFound". Verified against installed xrpl 5.0.0:
// - node_modules/xrpl/dist/npm/client/RequestManager.js:104 throws
//   new RippledError(message, errorResponse) — the rippled error response
//   lands on the error's .data
// - node_modules/xrpl/dist/npm/errors.js:4-10 — XrplError assigns this.data
// - node_modules/xrpl/dist/npm/sugar/submit.js:53-58 — xrpl's own
//   submitAndWait poller checks error?.data?.error === 'txnNotFound' and keeps
//   waiting: "not found" from a tx lookup means NOT FINAL YET, not failure.
const isTxnNotFound = (error) => error?.data?.error === "txnNotFound";

// Final failure classes on XRPL: tec* (claim failure), tef* (terminal local
// failure), tel* (local failure), tem* (malformed) — the transaction reached a
// final non-success state. tesSUCCESS is the only success code; any other
// verdict is treated as unresolved below, never guessed. The canonical test
// (isFinalFailure) lives in the domain module so the reconciler and the
// receipt classifier share one definition.

// Identity match BEFORE any classification: the looked-up transaction must be
// the payment this attempt describes — payer, destination, the exact RLUSD
// amount string, currency, issuer, source tag. A hash collision or a
// wrong-row lookup can then never advance a plan.
function attemptIdentityMatches(tx, record) {
  const amount = tx?.Amount;
  return (
    tx?.Account === record?.payer &&
    tx?.Destination === record?.destination &&
    typeof amount === "object" &&
    amount !== null &&
    amount.value === record?.amount &&
    amount.currency === record?.currency &&
    amount.issuer === record?.issuer &&
    tx?.SourceTag === record?.sourceTag
  );
}

// createReconciler({ fetchTransaction }) → { reconcileAttempt(record) }
//
// reconcileAttempt resolves { next, ledgerResult?, anomaly? } where next is
// one of the domain machine's post-submission states:
//
//   { next: "validated_success", ledgerResult: "tesSUCCESS" }
//       — tesSUCCESS on a transaction whose identity matches the attempt record.
//
//   { next: "validated_failure", ledgerResult: "<final failure code>" }
//       — a final te[cflm]* code on an identity-matched transaction.
//
//   { next: "unresolved", anomaly: "identity_mismatch" }
//       — a verdict on a transaction that is NOT this attempt's payment. The
//         verdict belongs to someone else's payment and is deliberately NOT
//         returned as ledgerResult for the caller to persist. The attempt
//         record schema (PR 11's allowlist) has no anomaly field, so flagging
//         rides the reconciler result — the caller surfaces it (history/debug
//         log) and the attempt stays unresolved.
//
//   { next: "unresolved" }
//       — no hash to look up, txnNotFound (not final yet), a lookup that
//         resolved without a readable verdict, or a transaction that is not
//         validated. No automatic retry may follow; the caller re-reconciles.
//
// Lookup errors other than txnNotFound are rethrown — a broken ledger client
// must be loud, never quietly classified as any outcome.
export function createReconciler({ fetchTransaction } = {}) {
  if (typeof fetchTransaction !== "function") {
    throw new TypeError("createReconciler requires { fetchTransaction } — an injected tx lookup");
  }

  async function reconcileAttempt(record) {
    if (!record?.hash) {
      return { next: OUTCOME_STATES.unresolved };
    }

    let tx;
    try {
      tx = await fetchTransaction(record.hash);
    } catch (error) {
      if (isTxnNotFound(error)) {
        return { next: OUTCOME_STATES.unresolved };
      }
      throw error;
    }
    if (tx == null || typeof tx !== "object") {
      return { next: OUTCOME_STATES.unresolved };
    }
    if (tx.validated === false) {
      // The tx command normally answers from the validated ledger (and errors
      // txnNotFound otherwise), but a lookup result that says "not validated"
      // is by definition not final — same treatment as txnNotFound. (xrpl's
      // own poller gates the same way: sugar/submit.js gates on
      // txResponse.result.validated before trusting the response.)
      return { next: OUTCOME_STATES.unresolved };
    }

    if (!attemptIdentityMatches(tx, record)) {
      return { next: OUTCOME_STATES.unresolved, anomaly: "identity_mismatch" };
    }

    const verdict = tx.meta?.TransactionResult ?? null;
    if (verdict === "tesSUCCESS") {
      return { next: OUTCOME_STATES.validated_success, ledgerResult: verdict };
    }
    if (isFinalFailure(verdict)) {
      return { next: OUTCOME_STATES.validated_failure, ledgerResult: verdict };
    }
    return { next: OUTCOME_STATES.unresolved };
  }

  return { reconcileAttempt };
}
