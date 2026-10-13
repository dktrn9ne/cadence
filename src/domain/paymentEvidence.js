export function hashUsedByAnotherInstallment(plans, hash, planId, sequence) {
  const normalized = String(hash ?? "").toUpperCase();
  if (!normalized) return false;
  return plans.some((plan) => Object.values(plan.attempts || {}).some((attempt) =>
    String(attempt.hash ?? "").toUpperCase() === normalized &&
    (plan.id !== planId || Number(attempt.sequence) !== Number(sequence)),
  ));
}
