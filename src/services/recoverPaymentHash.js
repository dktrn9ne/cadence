import { latestAttemptFor } from "../storage/planState.js";
import { isValidTxHash, lookupTransaction, OUTCOMES } from "./xrplLedger.js";

// Recovery never submits. A supplied public hash is classified only against
// the immutable identity of the held attempt, and cannot pay two installments.
export async function recoverPaymentHash({ plans, planId, hash, reconcile = lookupTransaction }) {
  const normalized = String(hash ?? "").trim().toUpperCase();
  if (!isValidTxHash(normalized)) throw new Error("Enter a 64-character XRPL transaction hash from your wallet history.");
  const plan = plans.find((item) => item.id === planId);
  const attempt = latestAttemptFor(plan, Number(plan?.paidCount || 0));
  if (!attempt || attempt.status !== "unresolved" || attempt.hash) {
    throw new Error("Only an unresolved installment without a hash can use this recovery step.");
  }
  for (const other of plans) {
    for (const recorded of Object.values(other.attempts || {})) {
      if (String(recorded.hash ?? "").toUpperCase() === normalized) {
        throw new Error("This transaction hash is already attached to another payment attempt.");
      }
    }
  }
  const result = await reconcile(normalized, {
    payer: attempt.payer, destination: attempt.destination, amount: attempt.amount,
  });
  if (result?.anomaly) throw new Error("The ledger transaction does not match this installment's payer, recipient, amount, or tag.");
  if (result?.outcome !== OUTCOMES.SUCCESS && result?.outcome !== OUTCOMES.FAILURE) {
    throw new Error("The ledger has not confirmed this transaction. The installment remains blocked; try again later.");
  }
  return { ...attempt, hash: normalized, status: result.outcome };
}
