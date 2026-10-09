import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReconciler } from "./ledgerReconciler.js";

// Architectural guard: the reconciler must classify over an INJECTED lookup.
// If this test file's import graph ever pulls in the real xrpl client (and
// with it socket-capable code), the mock factory throws and the suite fails.
vi.mock("xrpl", () => {
  throw new Error("tests must not import xrpl — the ledger lookup is injected");
});

// ---- Fixture provenance — read from source this session, not invented.
//
// The transaction object below is the .result of a
// client.request({ command: "tx", transaction: hash }) response — the shape
// installed xrpl 5.0.0's own poller consumes (node_modules/xrpl/dist/npm/
// sugar/submit.js: waitForFinalTransactionOutcome gates on
// txResponse.result.validated and reads the transaction). Field style follows
// rippled's tx JSON: uppercase Account/Destination/Amount/SourceTag, lowercase
// fee. Chain constants are the repo's own (src/domain/xrpl-constants.js:1-4).
// The attempt record mirrors the attempt-store schema (PR 11). Addresses are
// synthetic mainnet-format strings; hashes are arbitrary 64-hex. No mnemonic,
// seed, private key, or network anywhere in this file.
//
// The txnNotFound error shape is per installed xrpl 5.0.0:
// - node_modules/xrpl/dist/npm/client/RequestManager.js:104 — a rippled error
//   response is thrown as new RippledError(message, errorResponse): the whole
//   rippled error response lands on the error's .data
// - node_modules/xrpl/dist/npm/errors.js:4-10 — XrplError assigns this.data
// - node_modules/xrpl/dist/npm/sugar/submit.js:53-58 — xrpl itself reads
//   error?.data?.error === 'txnNotFound' from a tx lookup and treats it as
//   "not final yet" (it keeps polling) — the precedent for staying unresolved.
const TX_HASH = "44F0A1B2C3D4E5F60718293A4B5C6D7E8F901234567890ABCDEF0123456789AB";
const RLUSD = {
  currency: "524C555344000000000000000000000000000000",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
};
const SOURCE_TAG = 2606250005;
const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DESTINATION = "rFixtur3DestAcct11111111111111111111";

const ledgerTx = (overrides = {}) => ({
  Account: PAYER,
  Destination: DESTINATION,
  Amount: { currency: RLUSD.currency, issuer: RLUSD.issuer, value: "12.5000" },
  SourceTag: SOURCE_TAG,
  TransactionType: "Payment",
  fee: "12",
  hash: TX_HASH,
  meta: { TransactionResult: "tesSUCCESS", TransactionIndex: 3 },
  validated: true,
  ledger_index: 987654,
  ...overrides,
});

const attemptRecord = (overrides = {}) => ({
  id: "attempt-person-1734:0-1",
  installmentId: "person-1734:0",
  planId: "person-1734",
  sequence: 0,
  source: "scheduled",
  payer: PAYER,
  destination: DESTINATION,
  amount: "12.5000",
  currency: RLUSD.currency,
  issuer: RLUSD.issuer,
  sourceTag: SOURCE_TAG,
  hash: TX_HASH,
  ledgerResult: null,
  errorClass: null,
  state: "submitted",
  createdAt: 1760000000000,
  updatedAt: 1760000000000,
  ...overrides,
});

// A tx lookup that answers but the transaction is not in a validated ledger
// yet — txnNotFound per the xrpl error shape above.
const txnNotFoundError = Object.assign(new Error("Transaction not found."), {
  data: { error: "txnNotFound" },
});
// Any other lookup failure — must be rethrown, never classified.
const networkError = new Error("websocket connection closed unexpectedly");

let fetchTransaction;
let reconciler;

beforeEach(() => {
  fetchTransaction = vi.fn();
  reconciler = createReconciler({ fetchTransaction });
});

describe("createReconciler", () => {
  it("requires an injected fetchTransaction", () => {
    expect(() => createReconciler()).toThrow(TypeError);
    expect(() => createReconciler({})).toThrow(TypeError);
    expect(() => createReconciler({ fetchTransaction: "nope" })).toThrow(TypeError);
  });
});

describe("reconcileAttempt — classification table (AC-4, unit level)", () => {
  it("classifies tesSUCCESS with an identity match as validated_success", async () => {
    fetchTransaction.mockResolvedValue(ledgerTx());
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "validated_success",
      ledgerResult: "tesSUCCESS",
    });
    expect(fetchTransaction).toHaveBeenCalledTimes(1);
    expect(fetchTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it.each(["tecUNFUNDED_PAYMENT", "tefFAILURE", "telINSUF_FEE_P", "temMALFORMED"])(
    "classifies a final %s failure with an identity match as validated_failure",
    async (verdict) => {
      fetchTransaction.mockResolvedValue(ledgerTx({ meta: { TransactionResult: verdict } }));
      await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
        next: "validated_failure",
        ledgerResult: verdict,
      });
    },
  );

  it("treats an unknown verdict code as unresolved — never guessed", async () => {
    fetchTransaction.mockResolvedValue(ledgerTx({ meta: { TransactionResult: "NOT_A_REAL_CODE" } }));
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "unresolved",
    });
  });

  it("treats a validated transaction without a readable meta as unresolved", async () => {
    fetchTransaction.mockResolvedValue(ledgerTx({ meta: undefined }));
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "unresolved",
    });
  });
});

describe("reconcileAttempt — identity match before any classification", () => {
  // Each mismatch case: a tesSUCCESS transaction that is NOT this attempt's
  // payment. The verdict belongs to someone else — never surfaced as our
  // ledgerResult, never classified success or failure.
  const mismatchCases = [
    ["payer", { Account: "rSomeoneElse11111111111111111111111111" }],
    ["destination", { Destination: "rSomeoneElse11111111111111111111111111" }],
    ["amount value", { Amount: { currency: RLUSD.currency, issuer: RLUSD.issuer, value: "13.0000" } }],
    ["currency", { Amount: { currency: "XRP", issuer: RLUSD.issuer, value: "12.5000" } }],
    ["issuer", { Amount: { currency: RLUSD.currency, issuer: "rOtherIssuer111111111111111111111111", value: "12.5000" } }],
    ["missing source tag", { SourceTag: undefined }],
    ["different source tag", { SourceTag: 1234 }],
    ["XRP-denominated (string) amount", { Amount: "12500000" }],
  ];

  it.each(mismatchCases)("stays unresolved on %s mismatch and withholds the verdict", async (_field, override) => {
    fetchTransaction.mockResolvedValue(ledgerTx(override));
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "unresolved",
      anomaly: "identity_mismatch",
    });
  });

  it("checks identity before classification — a mismatched final failure is not our failure", async () => {
    fetchTransaction.mockResolvedValue(
      ledgerTx({ Account: "rSomeoneElse11111111111111111111111111", meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }),
    );
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "unresolved",
      anomaly: "identity_mismatch",
    });
  });
});

describe("reconcileAttempt — unresolved is safe on every not-final shape", () => {
  it("keeps a txnNotFound lookup unresolved (not final yet, not a failure)", async () => {
    fetchTransaction.mockRejectedValue(txnNotFoundError);
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "unresolved",
    });
    expect(fetchTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps a transaction that is not yet validated unresolved", async () => {
    fetchTransaction.mockResolvedValue(ledgerTx({ validated: false }));
    await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
      next: "unresolved",
    });
  });

  it("keeps a non-object lookup result unresolved", async () => {
    for (const result of [null, undefined]) {
      fetchTransaction.mockResolvedValue(result);
      await expect(reconciler.reconcileAttempt(attemptRecord())).resolves.toEqual({
        next: "unresolved",
      });
    }
  });

  it("rethrows lookup errors that are not txnNotFound — a broken client is loud", async () => {
    fetchTransaction.mockRejectedValue(networkError);
    await expect(reconciler.reconcileAttempt(attemptRecord())).rejects.toThrow(networkError);
  });

  it("never looks up an attempt without a hash", async () => {
    await expect(reconciler.reconcileAttempt(attemptRecord({ hash: null }))).resolves.toEqual({
      next: "unresolved",
    });
    expect(fetchTransaction).not.toHaveBeenCalled();
  });

  it("tolerates a missing record without touching the lookup", async () => {
    await expect(reconciler.reconcileAttempt(null)).resolves.toEqual({ next: "unresolved" });
    expect(fetchTransaction).not.toHaveBeenCalled();
  });
});

describe("zero network", () => {
  it("runs entirely over the injected lookup — no xrpl import, no socket", async () => {
    // If anything in the reconciler's import graph imported xrpl, the
    // vi.mock factory at the top of this file would have thrown on import.
    fetchTransaction.mockResolvedValue(ledgerTx());
    await reconciler.reconcileAttempt(attemptRecord());
    expect(fetchTransaction).toHaveBeenCalledTimes(1);
  });
});
