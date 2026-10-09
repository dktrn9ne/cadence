import { describe, expect, it, vi } from "vitest";
import {
  DEMO_PAYER_WALLET,
  RLUSD_CURRENCY,
  RLUSD_ISSUER,
  SOURCE_TAG,
  buildIncomeProofCsv,
  buildIncomeProofStats,
  findPayerMismatch,
  isMatchingIncomeTx,
  planInstallmentAction,
  resolvePayerForWallet,
  selectExcludedXrpEntries,
  selectIncomeRows,
  stampPlanPayer,
} from "./incomeProof";

// Constructed fixtures only — no live wallets, no seeds, no network.
const PAYER_A = "rPayerA1111111111111111111111111111";
const PAYER_B = "rPayerB2222222222222222222222222222";
const WORKER = "rWorker3333333333333333333333333333";
const OTHER_WORKER = "rWorker4444444444444444444444444444";
const FAKE_HASH = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";

// A fully matching account_tx entry as XRPL mainnet returns it.
const matchingEntry = (overrides = {}) => ({
  validated: true,
  hash: FAKE_HASH,
  ledger_index: 95845132,
  close_time_iso: "2026-10-01T12:00:00.000Z",
  meta: {
    TransactionResult: "tesSUCCESS",
    delivered_amount: { currency: "RLUSD", issuer: RLUSD_ISSUER, value: "25" },
  },
  tx_json: {
    TransactionType: "Payment",
    Account: PAYER_A,
    Destination: WORKER,
    SourceTag: SOURCE_TAG,
    date: 775000000,
    Amount: { currency: "RLUSD", issuer: RLUSD_ISSUER, value: "25" },
  },
  ...overrides,
});

const rlusd = (value, issuer = RLUSD_ISSUER) => ({ currency: "RLUSD", issuer, value });

describe("AC1 · isMatchingIncomeTx", () => {
  const expectMatch = (entry, args = { payer: PAYER_A, destination: WORKER }) => {
    const result = isMatchingIncomeTx(entry, args);
    if (!result) throw new Error("expected a full match");
  };

  const expectNoMatch = (entry, args = { payer: PAYER_A, destination: WORKER }) => {
    const result = isMatchingIncomeTx(entry, args);
    if (result) throw new Error("expected no match");
  };

  it("counts a fully matching validated tesSUCCESS payment", () => {
    expectMatch(matchingEntry());
  });

  it("accepts the 40-char hex RLUSD currency code as well as the ticker", () => {
    expectMatch(matchingEntry({
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: "25" } },
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: WORKER, SourceTag: SOURCE_TAG,
        Amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: "25" },
      },
    }));
  });

  it("excludes a payment from the wrong payer", () => {
    expectNoMatch(matchingEntry({
      tx_json: {
        TransactionType: "Payment", Account: PAYER_B, Destination: WORKER, SourceTag: SOURCE_TAG,
        Amount: rlusd("25"),
      },
    }));
  });

  it("excludes a payment to the wrong destination", () => {
    expectNoMatch(matchingEntry({
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: OTHER_WORKER, SourceTag: SOURCE_TAG,
        Amount: rlusd("25"),
      },
    }));
  });

  it("excludes a missing source tag (NaN fails closed)", () => {
    expectNoMatch(matchingEntry({
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: WORKER,
        Amount: rlusd("25"),
      },
    }));
  });

  it("excludes a wrong source tag", () => {
    expectNoMatch(matchingEntry({
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: WORKER, SourceTag: 111,
        Amount: rlusd("25"),
      },
    }));
  });

  it("excludes a non-RLUSD (XRP string) amount", () => {
    expectNoMatch(matchingEntry({
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: "25000000" },
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: WORKER, SourceTag: SOURCE_TAG,
        Amount: "25000000",
      },
    }));
  });

  it("excludes an RLUSD amount from the wrong issuer", () => {
    expectNoMatch(matchingEntry({
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: rlusd("25", "rWrongIssuer11111111111111111111111111") },
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: WORKER, SourceTag: SOURCE_TAG,
        Amount: rlusd("25", "rWrongIssuer11111111111111111111111111"),
      },
    }));
  });

  it.each(["tefFAILURE", "temBAD_AMOUNT", "tecPATH_DRY"])("excludes a %s result", (result) => {
    expectNoMatch(matchingEntry({
      meta: { TransactionResult: result, delivered_amount: rlusd("25") },
    }));
  });

  it("excludes an entry flagged validated: false", () => {
    expectNoMatch(matchingEntry({ validated: false }));
  });

  it("excludes non-Payment transaction types", () => {
    expectNoMatch(matchingEntry({
      tx_json: {
        TransactionType: "OfferCreate", Account: PAYER_A, Destination: WORKER, SourceTag: SOURCE_TAG,
        Amount: rlusd("25"),
      },
    }));
  });

  it("counts via the meta.delivered_amount fallback when tx amount is absent", () => {
    const { Amount, ...withoutAmount } = matchingEntry().tx_json;
    expectMatch(matchingEntry({ tx_json: withoutAmount }));
  });

  it("fails closed on missing or invalid payer/destination arguments", () => {
    const entry = matchingEntry();
    expectNoMatch(entry, {});
    expectNoMatch(entry, { payer: PAYER_A, destination: "" });
    expectNoMatch(entry, { payer: "not-an-address", destination: WORKER });
    expectNoMatch(undefined, { payer: PAYER_A, destination: WORKER });
  });
});

describe("AC1 · selectIncomeRows", () => {
  it("keeps account_tx newest-first order and carries the full public evidence", () => {
    const newer = matchingEntry({ hash: FAKE_HASH, ledger_index: 95845133, close_time_iso: "2026-10-02T12:00:00.000Z" });
    newer.meta = { ...newer.meta, delivered_amount: rlusd("10") };
    newer.tx_json = { ...newer.tx_json, Amount: rlusd("10") };
    const older = matchingEntry();
    const rows = selectIncomeRows([newer, older], { payer: PAYER_A, destination: WORKER });

    expect(rows).toHaveLength(2);
    expect(rows[0].iso).toBe("2026-10-02T12:00:00.000Z");
    expect(rows[0].amount).toBe(10);
    expect(rows[0].ledgerIndex).toBe(95845133);
    expect(rows[1].iso).toBe("2026-10-01T12:00:00.000Z");
    expect(rows[1].amount).toBe(25);
    expect(rows[1].ledgerIndex).toBe(95845132);
    for (const row of rows) {
      expect(row.payer).toBe(PAYER_A);
      expect(row.destination).toBe(WORKER);
      expect(row.currency).toBe("RLUSD");
      expect(row.issuer).toBe(RLUSD_ISSUER);
      expect(row.sourceTag).toBe(SOURCE_TAG);
      expect(row.result).toBe("tesSUCCESS");
      expect(row.hash).toBe(FAKE_HASH);
    }
  });

  it("drops entries that do not match the contract", () => {
    const wrongPayer = matchingEntry({
      tx_json: {
        TransactionType: "Payment", Account: PAYER_B, Destination: WORKER, SourceTag: SOURCE_TAG,
        Amount: rlusd("25"),
      },
    });
    const rows = selectIncomeRows([matchingEntry(), wrongPayer], { payer: PAYER_A, destination: WORKER });
    expect(rows).toHaveLength(1);
  });

  it("parses decimal string values into numbers", () => {
    const entry = matchingEntry();
    entry.meta = { ...entry.meta, delivered_amount: rlusd("25.5") };
    const [row] = selectIncomeRows([entry], { payer: PAYER_A, destination: WORKER });
    expect(row.amount).toBe(25.5);
  });
});

describe("selectExcludedXrpEntries", () => {
  it("counts successful XRP payments to the worker exactly once", () => {
    const xrpPayment = matchingEntry({
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: "123456" },
      tx_json: {
        TransactionType: "Payment", Account: PAYER_B, Destination: WORKER, SourceTag: undefined,
        Amount: "123456",
      },
    });
    delete xrpPayment.tx_json.SourceTag;
    const entries = selectExcludedXrpEntries([xrpPayment], WORKER);
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe(FAKE_HASH);
    const stats = buildIncomeProofStats({
      incomeRows: [],
      excludedXrpEntries: entries,
      markerRemaining: false,
    });
    expect(stats.totalExcludedXrp).toBeCloseTo(0.123456);
    expect(stats.excludedCount).toBe(1);
  });

  it("ignores RLUSD payments and payments to other wallets", () => {
    expect(selectExcludedXrpEntries([matchingEntry()], WORKER)).toHaveLength(0);
    expect(selectExcludedXrpEntries([matchingEntry()], OTHER_WORKER)).toHaveLength(0);
  });
});

describe("buildIncomeProofStats", () => {
  it("aggregates totals and projections from two rows one day apart", () => {
    const newer = matchingEntry({ close_time_iso: "2026-10-02T12:00:00.000Z" });
    newer.meta = { ...newer.meta, delivered_amount: rlusd("10") };
    const older = matchingEntry();
    const incomeRows = selectIncomeRows([newer, older], { payer: PAYER_A, destination: WORKER });
    const xrpPayment = matchingEntry({
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" },
      tx_json: {
        TransactionType: "Payment", Account: PAYER_A, Destination: WORKER,
        Amount: "1000000",
      },
    });
    const excluded = selectExcludedXrpEntries([xrpPayment], WORKER);
    const stats = buildIncomeProofStats({ incomeRows, excludedXrpEntries: excluded, markerRemaining: false });

    expect(stats.incomeCount).toBe(2);
    expect(stats.totalRlusd).toBe(35);
    expect(stats.excludedCount).toBe(1);
    expect(stats.totalExcludedXrp).toBe(1);
    expect(stats.observedDays).toBe(1);
    expect(stats.projectedWeekly).toBeCloseTo(245);
    expect(stats.projectedMonthly).toBeCloseTo(1050);
    expect(stats.projectedAnnual).toBeCloseTo(12775);
    expect(stats.lifetimeMatches).toBe(2);
  });

  it("flags partial history when a marker remains", () => {
    const [row] = selectIncomeRows([matchingEntry()], { payer: PAYER_A, destination: WORKER });
    const stats = buildIncomeProofStats({ incomeRows: [row], excludedXrpEntries: [], markerRemaining: true });
    expect(stats.lifetimeMatches).toBe("1+");
  });
});

describe("AC2 · resolvePayerForWallet", () => {
  const plan = (overrides = {}) => ({
    id: "plan-1",
    name: "Ada",
    address: WORKER,
    payer: PAYER_A,
    ...overrides,
  });

  it("prefers the payer attached to the matching plan", () => {
    expect(resolvePayerForWallet(WORKER, [plan()])).toEqual({ payer: PAYER_A, source: "plan", planId: "plan-1" });
  });

  it("falls back to the labeled demo payer when no plan resolves", () => {
    expect(resolvePayerForWallet(WORKER, [])).toEqual({ payer: DEMO_PAYER_WALLET, source: "demo-fallback", planId: null });
    expect(resolvePayerForWallet(WORKER, [plan({ address: OTHER_WORKER })])).toEqual({ payer: DEMO_PAYER_WALLET, source: "demo-fallback", planId: null });
  });

  it("falls back when the matching plan has no usable payer", () => {
    expect(resolvePayerForWallet(WORKER, [plan({ payer: undefined })])).toEqual({ payer: DEMO_PAYER_WALLET, source: "demo-fallback", planId: null });
    expect(resolvePayerForWallet(WORKER, [plan({ payer: "" })])).toEqual({ payer: DEMO_PAYER_WALLET, source: "demo-fallback", planId: null });
    expect(resolvePayerForWallet(WORKER, [plan({ payer: "not-an-address" })])).toEqual({ payer: DEMO_PAYER_WALLET, source: "demo-fallback", planId: null });
  });

  it("matches the plan by destination wallet", () => {
    const otherPlan = plan({ id: "plan-0", address: OTHER_WORKER, payer: PAYER_B });
    expect(resolvePayerForWallet(WORKER, [otherPlan, plan()])).toEqual({ payer: PAYER_A, source: "plan", planId: "plan-1" });
  });
});

describe("AC3 · stampPlanPayer", () => {
  it("stamps the connected wallet on create", () => {
    const stamped = stampPlanPayer({ name: "Ada", address: WORKER }, PAYER_A);
    expect(stamped.payer).toBe(PAYER_A);
  });

  it("re-stamps on edit by the currently connected wallet", () => {
    const stamped = stampPlanPayer({ name: "Ada", address: WORKER, payer: PAYER_B }, PAYER_A);
    expect(stamped.payer).toBe(PAYER_A);
  });

  it("clears the payer when no wallet is connected", () => {
    expect(stampPlanPayer({ name: "Ada", address: WORKER, payer: PAYER_A }, "").payer).toBeNull();
  });
});

describe("AC4 · payer guard (planInstallmentAction)", () => {
  const person = { name: "Ada", address: WORKER, payer: PAYER_A };
  const baseArgs = {
    connectedWallet: PAYER_A,
    hasSigningWallet: true,
    paidCount: 0,
    plannedPayments: 12,
  };

  // Mirrors the component wiring: nothing is constructed or signed unless the
  // decision says "proceed".
  const runPayFlow = async (submitter, subject, args) => {
    const decision = planInstallmentAction(subject, args);
    if (decision.action !== "proceed") return { blocked: decision };
    return { submitted: await submitter({ destination: subject.address, amount: "25" }) };
  };

  it("blocks a mismatched payer before any transaction is constructed", async () => {
    const submitter = vi.fn();
    const result = await runPayFlow(submitter, person, { ...baseArgs, connectedWallet: PAYER_B });
    expect(submitter).not.toHaveBeenCalled();
    expect(result.blocked).toEqual({ action: "payer_mismatch", pausePlan: true, expectedPayer: PAYER_A, connectedPayer: PAYER_B });
  });

  it("routes a payer-bound plan with no connected wallet to the missing-wallet block", () => {
    const submitter = vi.fn();
    const decision = planInstallmentAction(person, { ...baseArgs, connectedWallet: "", hasSigningWallet: false });
    expect(submitter).not.toHaveBeenCalled();
    expect(decision.action).toBe("missing_wallet_or_destination");
  });

  it("lets a matching payer proceed", async () => {
    const submitter = vi.fn(async () => ({ result: "ok" }));
    const result = await runPayFlow(submitter, person, baseArgs);
    expect(result.submitted).toEqual({ result: "ok" });
    expect(submitter).toHaveBeenCalledWith({ destination: WORKER, amount: "25" });
  });

  it("still blocks on missing wallet or destination", () => {
    expect(planInstallmentAction(person, { ...baseArgs, hasSigningWallet: false }).action).toBe("missing_wallet_or_destination");
    expect(planInstallmentAction({ ...person, address: "" }, baseArgs).action).toBe("missing_wallet_or_destination");
  });

  it("blocks a completed plan before anything else", () => {
    expect(planInstallmentAction(person, { ...baseArgs, paidCount: 12 })).toEqual({ action: "plan_complete" });
  });

  it("ignores the guard for plans without a payer", () => {
    expect(planInstallmentAction({ ...person, payer: undefined }, baseArgs).action).toBe("proceed");
    expect(planInstallmentAction({ ...person, payer: "" }, baseArgs).action).toBe("proceed");
  });

  it("findPayerMismatch returns the addresses to block on", () => {
    expect(findPayerMismatch(person, PAYER_B)).toEqual({ expectedPayer: PAYER_A, connectedPayer: PAYER_B });
    expect(findPayerMismatch(person, PAYER_A)).toBeNull();
    expect(findPayerMismatch({ ...person, payer: undefined }, PAYER_B)).toBeNull();
    expect(findPayerMismatch(person, "")).toEqual({ expectedPayer: PAYER_A, connectedPayer: null });
  });
});

describe("AC5 · buildIncomeProofCsv", () => {
  const HEADER = "time,amount_rlusd,payer,destination,currency,issuer,source_tag,ledger_result,tx_hash,ledger_index";

  it("writes the exact full-evidence header", () => {
    expect(buildIncomeProofCsv([])).toBe(HEADER);
  });

  it("quotes and escapes every field", () => {
    const csv = buildIncomeProofCsv([{
      iso: "2026-10-01T12:00:00.000Z",
      amount: 25,
      payer: 'rPayer"quoted',
      destination: WORKER,
      currency: "RLUSD",
      issuer: RLUSD_ISSUER,
      sourceTag: SOURCE_TAG,
      result: "tesSUCCESS",
      hash: FAKE_HASH,
      ledgerIndex: 95845132,
    }]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('"2026-10-01T12:00:00.000Z","25.000000","rPayer""quoted","rWorker3333333333333333333333333333","RLUSD","rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De","2606250005","tesSUCCESS","A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90","95845132"');
  });

  it("tolerates a missing ledger index", () => {
    const csv = buildIncomeProofCsv([{
      iso: "2026-10-01T12:00:00.000Z",
      amount: 25,
      payer: PAYER_A,
      destination: WORKER,
      currency: "RLUSD",
      issuer: RLUSD_ISSUER,
      sourceTag: SOURCE_TAG,
      result: "tesSUCCESS",
      hash: FAKE_HASH,
      ledgerIndex: undefined,
    }]);
    expect(csv.endsWith(',""')).toBe(true);
  });

  it("emits one row per counted payment", () => {
    const rows = selectIncomeRows([matchingEntry(), matchingEntry()], { payer: PAYER_A, destination: WORKER });
    expect(buildIncomeProofCsv(rows).split("\n")).toHaveLength(rows.length + 1);
  });
});
