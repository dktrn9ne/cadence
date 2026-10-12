import { Client } from "xrpl";
import { RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG } from "../domain/xrpl-constants.js";

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

// A hash that cannot be looked up is no hash: a rippled transaction hash is
// 256-bit hex. A malformed hash could never match a ledger transaction — it
// can only produce a doomed request or a null match, and both end at
// `still_unknown`, so the network round-trip is skipped entirely.
const TX_HASH_RE = /^[0-9A-Fa-f]{64}$/;
export const isValidTxHash = (hash) => typeof hash === "string" && TX_HASH_RE.test(hash);

// Pure classification: transaction object -> outcome. The ledger's own meta
// decides (mirrors the income-proof filters on meta.TransactionResult):
// `tesSUCCESS` validates the payment; any other result code the ledger
// reports is a validated failure; a usable-but-unrecognized code is still a
// failure, because the ledger answered and the answer was not success. A
// response without a readable TransactionResult classifies as unknown — a
// missing verdict must never be guessed as success or failure. A response the
// ledger has not validated yet (`validated: false`) carries provisional meta
// that can still flip before the ledger closes, so it is never a verdict
// either — an unclassified outcome keeps the installment blocked.
export const classifyTransactionResult = (tx) => {
  if (tx?.validated === false) return OUTCOMES.UNKNOWN;
  const txResultCode = tx?.meta?.TransactionResult;
  if (txResultCode === "tesSUCCESS") return OUTCOMES.SUCCESS;
  if (typeof txResultCode === "string" && txResultCode.length > 0) return OUTCOMES.FAILURE;
  return OUTCOMES.UNKNOWN;
};

// Identity match BEFORE any classification (audit art_FIvT05e6, violation 1;
// ported from the reviewed PR 03 reconciler): the looked-up transaction must
// BE the payment this attempt describes — payer, destination, the exact
// RLUSD amount string, currency, issuer, source tag. A hash collision or a
// wrong-row lookup can then never advance a plan. currency/issuer/sourceTag
// default to the app constants; every call site pays RLUSD.
// expected: { payer, destination, amount, currency?, issuer?, sourceTag? }.
export const attemptIdentityMatches = (tx, expected = {}) => {
  const amount = tx?.Amount;
  return (
    tx?.Account === expected?.payer &&
    tx?.Destination === expected?.destination &&
    typeof amount === "object" &&
    amount !== null &&
    amount.value === expected?.amount &&
    amount.currency === (expected?.currency ?? RLUSD_CURRENCY) &&
    amount.issuer === (expected?.issuer ?? RLUSD_ISSUER) &&
    tx?.SourceTag === (expected?.sourceTag ?? SOURCE_TAG)
  );
};

// Lookup against a caller-supplied client — the seam tests use to mock the
// ledger. Every failure mode inside (txnNotFound, timeout, disconnect,
// malformed request) resolves to `still_unknown` rather than rejecting:
// an unknown outcome blocks the installment, it never fails the caller.
// When `expected` is supplied, the transaction's identity is verified before
// its verdict may classify: a validated tesSUCCESS that is NOT this attempt's
// payment resolves `still_unknown` with `anomaly: "identity_mismatch"` — the
// verdict belongs to someone else's payment and must never advance a plan.
export const lookupWithClient = async (client, hash, expected) => {
  if (!isValidTxHash(hash)) {
    // Nothing to reconcile with — and no outcome can be conjured from it.
    return { outcome: OUTCOMES.UNKNOWN };
  }
  try {
    const response = await client.request({ command: "tx", transaction: hash });
    const tx = response?.result;
    if (expected && !attemptIdentityMatches(tx, expected)) {
      return { outcome: OUTCOMES.UNKNOWN, anomaly: "identity_mismatch" };
    }
    return { outcome: classifyTransactionResult(tx) };
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
export const lookupTransaction = async (hash, expected) => {
  if (!isValidTxHash(hash)) {
    return { outcome: OUTCOMES.UNKNOWN };
  }
  const client = new Client(XRPL_WS_URL);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await lookupWithClient(client, hash, expected);
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
