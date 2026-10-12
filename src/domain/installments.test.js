import { describe, expect, it } from "vitest";
import {
  OUTCOME_LABELS,
  OVERDUE_GRACE_MS,
  PAYER_MATCH,
  clampOverdue,
  classifyOutcome,
  installmentIdFor,
  payerMatchesPlan,
  readLedgerResult,
} from "./installments.js";

// Fixture discipline (vitest.setup.js house rules): public data only —
// synthetic mainnet-format addresses, fixture hashes. No secret material.
const PAYER = "rFixtur3PayerAcct11111111111111111111";
const OTHER_WALLET = "rFixtur3OtherAcct111111111111111111111";
const HASH = "44F0FAKEHASH0000000000000000000000000000000000000000000000000000";

describe("installmentIdFor", () => {
  it("is deterministic on plan id and sequence", () => {
    expect(installmentIdFor("person-1734", 3)).toBe("person-1734:3");
    expect(installmentIdFor("person-1734", 3)).toBe(installmentIdFor("person-1734", 3));
    expect(installmentIdFor("person-1734", 4)).not.toBe(installmentIdFor("person-1734", 3));
  });
});

describe("classifyOutcome", () => {
  it("labels a hash with tesSUCCESS as validated_success", () => {
    expect(classifyOutcome({ hash: HASH, ledgerResult: "tesSUCCESS" })).toBe(
      OUTCOME_LABELS.VALIDATED_SUCCESS,
    );
  });

  it("labels a hash with a tec-failure as validated_failure", () => {
    expect(classifyOutcome({ hash: HASH, ledgerResult: "tecPATH_DRY" })).toBe(
      OUTCOME_LABELS.VALIDATED_FAILURE,
    );
    expect(classifyOutcome({ hash: HASH, ledgerResult: "temBAD_AMOUNT" })).toBe(
      OUTCOME_LABELS.VALIDATED_FAILURE,
    );
  });

  it("labels a hash with no readable ledger result as unresolved", () => {
    expect(classifyOutcome({ hash: HASH, ledgerResult: null })).toBe(OUTCOME_LABELS.UNRESOLVED);
    expect(classifyOutcome({ hash: HASH, ledgerResult: undefined })).toBe(OUTCOME_LABELS.UNRESOLVED);
    expect(classifyOutcome({ hash: HASH, ledgerResult: "" })).toBe(OUTCOME_LABELS.UNRESOLVED);
  });

  it("labels a missing hash as failed_no_hash regardless of any result", () => {
    expect(classifyOutcome({ hash: null, ledgerResult: "tesSUCCESS" })).toBe(
      OUTCOME_LABELS.FAILED_NO_HASH,
    );
    expect(classifyOutcome({})).toBe(OUTCOME_LABELS.FAILED_NO_HASH);
    expect(classifyOutcome({ hash: "" })).toBe(OUTCOME_LABELS.FAILED_NO_HASH);
    expect(classifyOutcome()).toBe(OUTCOME_LABELS.FAILED_NO_HASH);
  });
});

describe("readLedgerResult", () => {
  it("reads meta.TransactionResult from a submitAndWait-shaped result", () => {
    expect(readLedgerResult({ result: { meta: { TransactionResult: "tesSUCCESS" } } })).toBe("tesSUCCESS");
  });

  it("reads nested manager responses", () => {
    expect(readLedgerResult({ result: { result: { meta: { TransactionResult: "tecPATH_DRY" } } } })).toBe("tecPATH_DRY");
  });

  it("returns null when no ledger result is readable", () => {
    expect(readLedgerResult(undefined)).toBeNull();
    expect(readLedgerResult({ result: { hash: HASH } })).toBeNull();
  });
});

describe("clampOverdue", () => {
  const NOW = 1_760_000_000_000;

  it("pushes an overdue timestamp into the grace window", () => {
    expect(clampOverdue(NOW - 5_000, NOW)).toBe(NOW + OVERDUE_GRACE_MS);
    expect(clampOverdue(NOW, NOW)).toBe(NOW + OVERDUE_GRACE_MS);
  });

  it("keeps a future timestamp", () => {
    expect(clampOverdue(NOW + 120_000, NOW)).toBe(NOW + 120_000);
  });

  it("keeps null/unscheduled plans unscheduled", () => {
    expect(clampOverdue(null, NOW)).toBeNull();
    expect(clampOverdue(undefined, NOW)).toBeNull();
  });
});

describe("payerMatchesPlan", () => {
  it("treats a legacy plan without payerAddress as unpinned — dispatch unchanged", () => {
    expect(payerMatchesPlan({ id: "p1", address: "rDest" }, PAYER)).toBe(PAYER_MATCH.UNPINNED);
    expect(payerMatchesPlan({ id: "p1", payerAddress: "" }, PAYER)).toBe(PAYER_MATCH.UNPINNED);
  });

  it("matches a pinned plan for the authorizing account", () => {
    expect(payerMatchesPlan({ id: "p1", payerAddress: PAYER }, PAYER)).toBe(PAYER_MATCH.MATCH);
  });

  it("reports a mismatch for a different connected wallet", () => {
    expect(payerMatchesPlan({ id: "p1", payerAddress: PAYER }, OTHER_WALLET)).toBe(PAYER_MATCH.MISMATCH);
  });
});
