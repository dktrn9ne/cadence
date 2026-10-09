// Normalizes submission responses from both wallet paths into one outcome
// shape — the point where "desktop says X, XRPL Connect says Y" dies. Pure
// extraction: no client, no store, no state, no throwing.
//
// Contract (spec art_XPj3pWA4, "What we build" 2) — returns { hash, ledgerResult }:
// - ledgerResult present → classify immediately (tesSUCCESS vs a final
//   te[cflm]* failure code).
// - hash without ledgerResult → the caller holds the attempt at "submitted"
//   and reconciles by hash. A resolved submission with a hash but no readable
//   verdict is never success.
// - neither hash nor ledgerResult → the caller holds the attempt at
//   "unresolved". A resolved submission with neither proves nothing — the
//   response's existence is not evidence of payment.
//
// Shape provenance (read from source this session, not assumed):
// - Desktop receipt: submitRlusdPayment returns { result: <submitAndWait
//   Response>, hash: signed.hash, transaction } — src/CadenceDashboard.jsx:384-396
//   on this branch. The submitAndWait resolution carries .result with hash,
//   meta.TransactionResult and validated (installed xrpl 5.0.0,
//   node_modules/xrpl/dist/npm/sugar/submit.js — waitForFinalTransactionOutcome
//   returns txResponse once txResponse.result.validated is truthy).
// - XRPL Connect adapters (installed @textrp/xrpl-connect 0.6.0,
//   index-Cb4WhEOa.mjs) return adapter-specific shapes, none of which ever
//   carry a ledger verdict ("TransactionResult" occurs nowhere in the bundle):
//     Xaman     { hash: payload.txid, tx_blob, signature }    bundle:8081-8085
//     Crossmark { hash: n.response.data.resp.result.hash }    bundle:9337-9343
//     GemWallet { hash: n.result.hash }                       bundle:12498-12501
//     Xyra      { hash: t.hash || "", tx_blob }               bundle:27298-27301

// XRPL transaction hashes are 64 hex characters. A response "hash" that fails
// this shape check cannot be looked up — treating it as no-hash lands the
// attempt in unresolved (safe) instead of feeding garbage to a ledger lookup.
// In practice every real wallet hash passes; the filter only ever catches
// empty-string or malformed values such as Xyra's "" fallback.
const TX_HASH = /^[0-9a-fA-F]{64}$/;

export const isValidTxHash = (hash) => typeof hash === "string" && TX_HASH.test(hash);

// Ledger-meta extraction paths, most specific wrapper first:
// - response.result.result.meta — the desktop submitter wrapper
//   ({ result: <submitAndWait Response>, hash, transaction })
// - response.result.meta        — a raw xrpl.js Response (what submitAndWait resolves to)
// - response.meta               — a validated transaction object (the tx-command result shape)
const LEDGER_RESULT_PATHS = [
  (response) => response?.result?.result?.meta?.TransactionResult,
  (response) => response?.result?.meta?.TransactionResult,
  (response) => response?.meta?.TransactionResult,
];

// The responseHash fallback chain absorbed from the dashboard
// (src/CadenceDashboard.jsx:321-328 on this branch; six shapes + null).
// Path 1 is Crossmark's raw response nesting (xrpl-connect bundle:9337);
// paths 2-4 are the dashboard's defensive variants of that nesting; paths 5-6
// cover the submitter-computed shapes ({ result: { hash } } and { hash }).
const HASH_PATHS = [
  (response) => response?.response?.data?.resp?.result?.hash,
  (response) => response?.response?.data?.result?.hash,
  (response) => response?.data?.resp?.result?.hash,
  (response) => response?.data?.result?.hash,
  (response) => response?.result?.hash,
  (response) => response?.hash,
];

// Hash candidates in precedence order — a validated receipt's own hash first
// (authoritative once a verdict exists), then the absorbed chain over the
// wrapper, then the chain over a bare adapter result.
const LEDGER_HASH_PATHS = [
  (response) => response?.result?.result?.hash,
  (response) => response?.result?.hash,
];

function firstNonEmptyString(paths, arg) {
  for (const path of paths) {
    const value = path(arg);
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

// Resolves to the first hash candidate that is a plausibly valid XRPL
// transaction hash, or null. An empty-string or malformed candidate is
// skipped — never surfaced as a lookupable hash.
export function extractHash(response) {
  const candidates = [
    firstNonEmptyString(LEDGER_HASH_PATHS, response),
    firstNonEmptyString(HASH_PATHS, response),
    firstNonEmptyString(HASH_PATHS, response?.result),
  ];
  const found = candidates.find((value) => value !== null);
  return isValidTxHash(found) ? found : null;
}

// Both wallet paths, one shape. Accepts whatever either submitter resolves
// with — the full { result, hash, transaction } wrapper or a bare adapter or
// ledger response. Throws nothing: any unrecognized input normalizes to
// { hash: null, ledgerResult: null }, the unresolved contract.
export function normalizeSubmitOutcome(response) {
  return {
    hash: extractHash(response),
    ledgerResult: firstNonEmptyString(LEDGER_RESULT_PATHS, response),
  };
}
