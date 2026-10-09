// Cadence income-proof domain logic. Pure functions only — no React, no network.
// A transaction counts toward a worker's income proof ONLY when every public field
// matches: validated tesSUCCESS Payment from the plan's payer to the worker's
// destination, carrying the Cadence source tag and a delivered RLUSD amount from the
// expected issuer. Missing fields fail closed. These functions carry public evidence
// only — never secret material.
import { CADENCE_EMPLOYER_WALLET, RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG } from "./xrpl-constants.js";

export { RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG };
// Labeled demo fallback: the historical hardcoded employer wallet, used only when no
// plan with a valid payer resolves for the connected wallet. Revisit when the
// durable-storage lane lands.
export const DEMO_PAYER_WALLET = CADENCE_EMPLOYER_WALLET;

export const rippleTimeToIso = (seconds) =>
  seconds ? new Date((seconds + 946684800) * 1000).toISOString() : new Date().toISOString();

const txJson = (entry) => entry.tx_json || entry.tx || {};

export const deliveredIssuedAmount = (entry) => {
  const delivered = entry.meta?.delivered_amount;
  if (delivered && typeof delivered === "object") return delivered;
  const amount = txJson(entry).Amount || txJson(entry).DeliverMax;
  return amount && typeof amount === "object" ? amount : null;
};

const deliveredXrp = (entry) => {
  const delivered = entry.meta?.delivered_amount;
  if (typeof delivered === "string") return Number(delivered) / 1000000;
  const amount = txJson(entry).Amount || txJson(entry).DeliverMax;
  return typeof amount === "string" ? Number(amount) / 1000000 : 0;
};

export const isRlusdAmount = (amount) =>
  amount &&
  (amount.currency === "RLUSD" || amount.currency === RLUSD_CURRENCY) &&
  amount.issuer === RLUSD_ISSUER;

const formatProofTime = (iso) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// The strict match contract. Every field must match; missing fields fail closed.
// A hash or wallet response never counts as validated success.
export const isMatchingIncomeTx = (entry, { payer, destination }) => {
  if (!entry) return false; // fail closed on a missing entry
  if (!payer?.startsWith("r") || !destination?.startsWith("r")) return false;
  if (entry.validated === false) return false;
  if (entry.meta?.TransactionResult !== "tesSUCCESS") return false;
  const tx = txJson(entry);
  if (tx.TransactionType !== "Payment") return false;
  if (tx.Account !== payer) return false;
  if (tx.Destination !== destination) return false;
  if (Number(tx.SourceTag) !== SOURCE_TAG) return false;
  const amount = deliveredIssuedAmount(entry);
  return Boolean(isRlusdAmount(amount));
};

// Newest-first selection preserving account_tx order; every row carries the full
// public evidence for the payment it counts.
export const selectIncomeRows = (transactions, { payer, destination }) =>
  transactions
    .filter((entry) => isMatchingIncomeTx(entry, { payer, destination }))
    .map((entry) => {
      const tx = txJson(entry);
      const amount = deliveredIssuedAmount(entry);
      const iso = entry.close_time_iso || rippleTimeToIso(tx.date);
      return {
        time: formatProofTime(iso),
        iso,
        amount: Number(amount.value || 0),
        payer,
        destination,
        currency: "RLUSD",
        issuer: RLUSD_ISSUER,
        sourceTag: SOURCE_TAG,
        result: entry.meta?.TransactionResult,
        hash: entry.hash,
        ledgerIndex: entry.ledger_index || tx.ledger_index,
      };
    });

// Successful XRP payments to the worker that do not carry an issued RLUSD amount —
// on-chain activity excluded from income, reported for transparency.
export const selectExcludedXrpEntries = (transactions, destination) =>
  transactions.filter((entry) => {
    const tx = txJson(entry);
    return (
      entry.meta?.TransactionResult === "tesSUCCESS" &&
      tx.TransactionType === "Payment" &&
      tx.Destination === destination &&
      !deliveredIssuedAmount(entry) &&
      deliveredXrp(entry) > 0
    );
  });

export const buildIncomeProofStats = ({ incomeRows, excludedXrpEntries, markerRemaining }) => {
  const totalRlusd = incomeRows.reduce((sum, row) => sum + row.amount, 0);
  const totalExcludedXrp = excludedXrpEntries.reduce((sum, entry) => sum + deliveredXrp(entry), 0);
  const newest = incomeRows[0] ? new Date(incomeRows[0].iso).getTime() : Date.now();
  const oldest = incomeRows[incomeRows.length - 1] ? new Date(incomeRows[incomeRows.length - 1].iso).getTime() : newest;
  const observedDays = Math.max(1 / 24, (newest - oldest) / 86400000);
  const dailyRate = totalRlusd / observedDays;

  return {
    incomeCount: incomeRows.length,
    totalRlusd,
    excludedCount: excludedXrpEntries.length,
    totalExcludedXrp,
    projectedWeekly: dailyRate * 7,
    projectedMonthly: dailyRate * 30,
    projectedAnnual: dailyRate * 365,
    lifetimeMatches: markerRemaining ? `${incomeRows.length}+` : incomeRows.length,
    observedDays,
  };
};

// Complete public evidence for every counted payment — one CSV row per proof row,
// quoted and escaped. Public fields only; never secrets.
export const buildIncomeProofCsv = (rows) => {
  const header = "time,amount_rlusd,payer,destination,currency,issuer,source_tag,ledger_result,tx_hash,ledger_index";
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((row) =>
    [
      row.iso,
      row.amount.toFixed(6),
      row.payer,
      row.destination,
      row.currency,
      row.issuer,
      row.sourceTag,
      row.result,
      row.hash,
      row.ledgerIndex ?? "",
    ]
      .map(escape)
      .join(",")
  );
  return [header, ...lines].join("\n");
};

// Payer resolution for a connected wallet: the payer attached to the worker's plan
// wins; without a matching plan the labeled Cadence demo payer applies.
export const resolvePayerForWallet = (connectedWallet, people = []) => {
  const plan = (people || []).find((person) => person.address === connectedWallet && person.payer?.startsWith("r"));
  if (plan) return { payer: plan.payer, source: "plan", planId: plan.id };
  return { payer: DEMO_PAYER_WALLET, source: "demo-fallback", planId: null };
};

// Whoever saves a plan is who will sign for it: stamp the connected wallet as the
// plan's payer on create and re-stamp it on every edit.
export const stampPlanPayer = (draft, connectedWallet) => ({
  ...draft,
  payer: connectedWallet?.startsWith("r") ? connectedWallet : null,
});

// Payment-safety guard: a plan that carries a payer may only be paid by that payer.
// Returns null when the connected wallet is authorized, or the mismatch to block on.
export const findPayerMismatch = (person, connectedWallet) => {
  if (!person?.payer?.startsWith("r")) return null;
  if (person.payer === connectedWallet) return null;
  return { expectedPayer: person.payer, connectedPayer: connectedWallet || null };
};

// Pre-submit decision for one installment, in the order payInstallment applies it.
// The submitter runs only on "proceed"; every other action returns before any
// transaction is constructed or signed.
export const planInstallmentAction = (person, { connectedWallet, hasSigningWallet, paidCount, plannedPayments }) => {
  if (Number(paidCount || 0) >= plannedPayments) return { action: "plan_complete" };
  if (!hasSigningWallet || !person.address?.startsWith("r")) return { action: "missing_wallet_or_destination" };
  const mismatch = findPayerMismatch(person, connectedWallet);
  if (mismatch) return { action: "payer_mismatch", pausePlan: true, ...mismatch };
  return { action: "proceed" };
};
