import { describe, expect, it } from "vitest";
import { isValidTxHash, normalizeSubmitOutcome } from "./normalizeOutcome.js";

// ---- Fixture provenance — every shape below was read from source this
// session; nothing is invented. Per-shape citations in the comments, and the
// module header carries the same map.
//
// Chain constants: RLUSD currency/issuer and the Cadence source tag are the
// repo's own values (src/domain/xrpl-constants.js:1-4). Addresses are
// synthetic mainnet-format strings; tx hashes are arbitrary 64-hex strings.
// No mnemonic, seed, private key, or network appears anywhere.
//
// Desktop receipt (submitRlusdPayment, src/services/payments.js:21-30):
// { result: <submitAndWait Response>, hash: signed.hash, transaction }.
// The submitAndWait Response envelope — .result with hash,
// meta.TransactionResult, validated — is per installed xrpl 5.0.0
// (node_modules/xrpl/dist/npm/sugar/submit.js:
// waitForFinalTransactionOutcome returns txResponse once
// txResponse.result.validated is truthy).
//
// XRPL Connect adapter returns (installed @textrp/xrpl-connect 0.6.0,
// index-Cb4WhEOa.mjs):
//   Xaman     { hash: payload.txid, tx_blob, signature }   bundle:8081-8085
//   Crossmark { hash: n.response.data.resp.result.hash }   bundle:9337-9343
//   GemWallet { hash: n.result.hash }                      bundle:12498-12501
//   Xyra      { hash: t.hash || "", tx_blob }              bundle:27298-27301
// No adapter shape carries a ledger verdict: "TransactionResult" occurs
// nowhere in the bundle.

const TX_HASH = "44F0A1B2C3D4E5F60718293A4B5C6D7E8F901234567890ABCDEF0123456789AB";
const OTHER_HASH = "A1B2C3D4E5F60718293A4B5C6D7E8F901234567890ABCDEF0123456789AB44F0";
const RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
};
const SOURCE_TAG = 2606250005;
const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DESTINATION = "rFixtur3DestAcct11111111111111111111";

// Desktop submitter return — the only path whose resolved response carries a
// ledger verdict (submitAndWait waits for validation).
const desktopReceipt = ({ txHash = TX_HASH, signedHash = TX_HASH, verdict = "tesSUCCESS" } = {}) => ({
  result: {
    id: 7,
    type: "response",
    result: {
      Account: PAYER,
      Destination: DESTINATION,
      Amount: { currency: RLUSD.currency, issuer: RLUSD.issuer, value: "12.5000" },
      SourceTag: SOURCE_TAG,
      TransactionType: "Payment",
      fee: "12",
      hash: txHash,
      meta: { TransactionResult: verdict, TransactionIndex: 3 },
      validated: true,
      ledger_index: 987654,
    },
  },
  hash: signedHash, // signed.hash — deterministic pre-submission hash (services/payments.js:29)
  transaction: { TransactionType: "Payment", SourceTag: SOURCE_TAG },
});

// Adapter returns, transcribed from the installed bundle (citations above).
const xamanResult = { hash: TX_HASH, tx_blob: "0123ABCD", signature: "A1B2C3" };
const crossmarkRaw = { response: { data: { resp: { result: { hash: TX_HASH } } } } };
const crossmarkAdapter = { hash: TX_HASH };
const gemwalletRaw = { result: { hash: TX_HASH } };
const gemwalletAdapter = { hash: TX_HASH };
const xyraResultNoHash = { hash: "", tx_blob: "0123ABCD" };

// The submitter wrapper shape (submitXrplConnectRlusdPayment,
// src/services/payments.js:12-18): { result: <adapter result>,
// hash: responseHash(result), transaction }. responseHash of an adapter result
// without a hash is null.
const xrplConnectWrapper = (adapterResult, hash = TX_HASH) => ({
  result: adapterResult,
  hash,
  transaction: { TransactionType: "Payment", SourceTag: SOURCE_TAG },
});

describe("normalizeSubmitOutcome", () => {
  describe("desktop receipt path", () => {
    it("reads the verdict and the ledger hash from the submitAndWait receipt", () => {
      expect(normalizeSubmitOutcome(desktopReceipt())).toEqual({
        hash: TX_HASH,
        ledgerResult: "tesSUCCESS",
      });
    });

    it("reads final failure verdicts the same way", () => {
      const outcome = normalizeSubmitOutcome(
        desktopReceipt({ verdict: "tecUNFUNDED_PAYMENT" }),
      );
      expect(outcome.ledgerResult).toBe("tecUNFUNDED_PAYMENT");
      expect(outcome.hash).toBe(TX_HASH);
    });

    it("prefers the receipt's ledger hash over the wrapper's signed hash when both exist", () => {
      const outcome = normalizeSubmitOutcome(
        desktopReceipt({ txHash: OTHER_HASH, signedHash: TX_HASH }),
      );
      expect(outcome.hash).toBe(OTHER_HASH);
    });

    it("normalizes a raw submitAndWait Response (not wrapped) to the same shape", () => {
      const rawResponse = desktopReceipt().result;
      expect(normalizeSubmitOutcome(rawResponse)).toEqual({
        hash: TX_HASH,
        ledgerResult: "tesSUCCESS",
      });
    });
  });

  describe("XRPL Connect adapter path — every installed shape", () => {
    it("normalizes the Xaman adapter result and its submitter wrapper identically", () => {
      expect(normalizeSubmitOutcome(xamanResult)).toEqual({ hash: TX_HASH, ledgerResult: null });
      expect(normalizeSubmitOutcome(xrplConnectWrapper(xamanResult))).toEqual({
        hash: TX_HASH,
        ledgerResult: null,
      });
    });

    it("normalizes Crossmark's raw response nesting (chain path 1) and the narrowed adapter result identically", () => {
      expect(normalizeSubmitOutcome(crossmarkRaw)).toEqual({ hash: TX_HASH, ledgerResult: null });
      expect(normalizeSubmitOutcome(crossmarkAdapter)).toEqual({ hash: TX_HASH, ledgerResult: null });
      expect(normalizeSubmitOutcome(xrplConnectWrapper(crossmarkAdapter))).toEqual({
        hash: TX_HASH,
        ledgerResult: null,
      });
    });

    it("normalizes GemWallet's raw result nesting (chain path 5) and the narrowed adapter result identically", () => {
      expect(normalizeSubmitOutcome(gemwalletRaw)).toEqual({ hash: TX_HASH, ledgerResult: null });
      expect(normalizeSubmitOutcome(gemwalletAdapter)).toEqual({ hash: TX_HASH, ledgerResult: null });
      expect(normalizeSubmitOutcome(xrplConnectWrapper(gemwalletAdapter))).toEqual({
        hash: TX_HASH,
        ledgerResult: null,
      });
    });

    it("maps Xyra's empty-string hash fallback (bundle:27298-27301) to no hash at all", () => {
      expect(normalizeSubmitOutcome(xyraResultNoHash)).toEqual({ hash: null, ledgerResult: null });
      expect(normalizeSubmitOutcome(xrplConnectWrapper(xyraResultNoHash, null))).toEqual({
        hash: null,
        ledgerResult: null,
      });
    });

    it("never invents a verdict for adapter shapes — a resolved submission without a readable receipt is not success", () => {
      for (const shape of [xamanResult, crossmarkRaw, gemwalletRaw, xyraResultNoHash]) {
        expect(normalizeSubmitOutcome(shape).ledgerResult).toBeNull();
      }
    });
  });

  describe("absorbed responseHash chain — all six shapes plus null", () => {
    // Paths 2-4 are the dashboard's defensive variants of Crossmark's raw
    // nesting (src/domain/payments.js:18-25); they are not produced by any
    // installed adapter, but the chain absorbs them so no historical response
    // shape normalizes differently than it did before this module existed.
    const chainShapes = [
      ["path 1 (Crossmark raw)", crossmarkRaw],
      ["path 2", { response: { data: { result: { hash: TX_HASH } } } }],
      ["path 3", { data: { resp: { result: { hash: TX_HASH } } } }],
      ["path 4", { data: { result: { hash: TX_HASH } } }],
      ["path 5 (GemWallet raw)", gemwalletRaw],
      ["path 6 (narrowed adapters / signed hash)", { hash: TX_HASH }],
    ];

    it.each(chainShapes)("extracts the hash through %s", (_label, shape) => {
      expect(normalizeSubmitOutcome(shape).hash).toBe(TX_HASH);
      expect(normalizeSubmitOutcome(shape).ledgerResult).toBeNull();
    });

    it("falls through to null when no path matches — and null normalizes to the unresolved contract", () => {
      expect(normalizeSubmitOutcome({ response: { data: {} } })).toEqual({
        hash: null,
        ledgerResult: null,
      });
    });
  });

  describe("unresolved contract — never success on nothing", () => {
    it("normalizes unrecognizable responses to { hash: null, ledgerResult: null }", () => {
      for (const garbage of [null, undefined, "ok", 42, {}, [], { result: "x" }]) {
        expect(normalizeSubmitOutcome(garbage)).toEqual({ hash: null, ledgerResult: null });
      }
    });

    it("rejects malformed hashes — a hash that cannot be looked up is no hash", () => {
      const shortHash = TX_HASH.slice(0, 40); // 40 hex chars — not a 256-bit hash
      expect(normalizeSubmitOutcome({ hash: shortHash }).hash).toBeNull();
      expect(normalizeSubmitOutcome({ hash: "" }).hash).toBeNull();
      expect(normalizeSubmitOutcome({ hash: `x${TX_HASH.slice(1)}` }).hash).toBeNull();
    });
  });
  describe("AC-1 — one outcome shape across paths", () => {
    it("normalizes the same logical submission through every adapter shape to one identical result", () => {
      const adapterShapes = [
        xamanResult,
        crossmarkRaw,
        crossmarkAdapter,
        gemwalletRaw,
        gemwalletAdapter,
        xrplConnectWrapper(xamanResult),
        xrplConnectWrapper(crossmarkAdapter),
        xrplConnectWrapper(gemwalletAdapter),
      ];
      for (const shape of adapterShapes) {
        expect(normalizeSubmitOutcome(shape)).toEqual({ hash: TX_HASH, ledgerResult: null });
      }
    });

    it("classifies the desktop receipt through the same shape, plus the verdict only it carries", () => {
      expect(normalizeSubmitOutcome(desktopReceipt())).toEqual({
        hash: TX_HASH,
        ledgerResult: "tesSUCCESS",
      });
    });
  });

  describe("isValidTxHash", () => {
    it("accepts 64 hex characters in either case", () => {
      expect(isValidTxHash(TX_HASH)).toBe(true);
      expect(isValidTxHash(TX_HASH.toLowerCase())).toBe(true);
    });

    it("rejects anything else", () => {
      expect(isValidTxHash("")).toBe(false);
      expect(isValidTxHash(TX_HASH.slice(1))).toBe(false);
      expect(isValidTxHash(`${TX_HASH}F0`)).toBe(false);
      expect(isValidTxHash(null)).toBe(false);
      expect(isValidTxHash(42)).toBe(false);
    });
  });
});
