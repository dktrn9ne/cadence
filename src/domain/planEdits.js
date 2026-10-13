import { stampPlanPayer } from "./incomeProof.js";

const TERM_FIELDS = ["address", "payMode", "weeklyPay", "hourlyPay", "hoursPerWeek", "frequency"];
const LIVE_FIELDS = ["id", "attempts", "paidCount", "active", "nextRunAt", "catchUpPending", "missedCount", "recovered"];

// An editor draft may predate a scheduler/ledger update. It can change labels,
// but must never replace live progress or delete the attempt blocking dispatch.
export function mergePlanEdit(draft, current, connectedWallet) {
  if (current && (current.active || Number(current.paidCount || 0) > 0 || Object.keys(current.attempts || {}).length > 0)) {
    if (TERM_FIELDS.some((key) => String(draft[key] ?? "") !== String(current[key] ?? "")) || current.payer !== connectedWallet) {
      throw new Error("Payment terms are locked while active or after an attempt starts. Pause this plan and create a new plan for changed terms.");
    }
  }
  const next = stampPlanPayer(draft, connectedWallet);
  if (!current) return next;
  for (const field of LIVE_FIELDS) next[field] = current[field];
  return next;
}
