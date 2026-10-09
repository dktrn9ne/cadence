import { Client } from "xrpl";

// Reconciliation read for unresolved installments (PR 04). An installment left
// in `unresolved` — submitted on-ledger, outcome never observed (reload,
// timeout, disconnect) — may only leave that state through a lookup by its
// transaction hash. This module is the narrowest read that satisfies that
// rule: classify one hash, once. No retries, no caching, no scheduling here.

const XRPL_WS_URL = "wss://s1.ripple.com";

// Normalized reconciliation outcomes. `validated_success` is the only outcome
// a caller may use to advance a plan; `still_unknown` keeps the installment
// blocked — it is a verdict, not an error.
export const OUTCOMES = {
  SUCCESS: "validated_success",
  FAILURE: "validated_failure",
  UNKNOWN: "still_unknown",
};

// Pure classification: transaction object -> outcome. The ledger's own meta
// decides (mirrors the income-proof filters on meta.TransactionResult):
// `tesSUCCESS` validates the payment; any other result code the ledger
// reports is a validated failure; a usable-but-unrecognized code is still a
// failure, because the ledger answered and the answer was not success. A
// response without a readable TransactionResult classifies as unknown — a
// missing verdict must never be guessed as success or failure.
export const classifyTransactionResult = (tx) => {
  const txResultCode = tx?.meta?.TransactionResult;
  if (txResultCode === "tesSUCCESS") return OUTCOMES.SUCCESS;
  if (typeof txResultCode === "string" && txResultCode.length > 0) return OUTCOMES.FAILURE;
  return OUTCOMES.UNKNOWN;
};

// Lookup against a caller-supplied client — the seam tests use to mock the
// ledger. Every failure mode inside (txnNotFound, timeout, disconnect,
// malformed request) resolves to `still_unknown` rather than rejecting:
// an unknown outcome blocks the installment, it never fails the caller.
export const lookupWithClient = async (client, hash) => {
  if (typeof hash !== "string" || hash.length === 0) {
    // Nothing to reconcile with — and no outcome can be conjured from it.
    return { outcome: OUTCOMES.UNKNOWN };
  }
  try {
    const response = await client.request({ command: "tx", transaction: hash });
    return { outcome: classifyTransactionResult(response?.result) };
  } catch {
    // Server and transport errors both mean "outcome not observed": the
    // ledger rejected the lookup (txnNotFound, malformed) or the connection
    // failed (timeout, disconnect). Resolve unknown; never guess.
    return { outcome: OUTCOMES.UNKNOWN };
  }
};

// Public entry point. Reuses the dashboard's per-call connection pattern
// (submitRlusdPayment): one Client per lookup, connected, used, disconnected.
// A failed connect or a failed disconnect is transport failure — the lookup
// resolves `still_unknown`; a disconnect error after a successful lookup must
// not clobber the classification that was already earned.
export const lookupTransaction = async (hash) => {
  if (typeof hash !== "string" || hash.length === 0) {
    return { outcome: OUTCOMES.UNKNOWN };
  }
  const client = new Client(XRPL_WS_URL);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await lookupWithClient(client, hash);
  } catch {
    return { outcome: OUTCOMES.UNKNOWN };
  } finally {
    if (connected) {
      try {
        await client.disconnect();
      } catch {
        // Cleanup on an already-broken transport; result already decided.
      }
    }
  }
};
