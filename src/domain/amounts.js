// Six-decimal RLUSD accounting. BigInt never enters JSON or wallet payloads.
const SCALE = 1_000_000n;

export function amountUnits(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(text)) {
    throw new Error("Enter a non-negative amount with at most six decimal places.");
  }
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function unitsAmount(units) {
  if (units < 0n) throw new Error("Payment amount cannot be negative.");
  return `${units / SCALE}.${String(units % SCALE).padStart(6, "0")}`;
}

export function weeklyUnits(plan) {
  if (plan.payMode === "hourly") {
    const product = amountUnits(plan.hourlyPay) * amountUnits(plan.hoursPerWeek);
    return (product + SCALE / 2n) / SCALE;
  }
  return amountUnits(plan.weeklyPay ?? plan.amount);
}

export function installmentAmount(plan, sequence, paymentCount) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= paymentCount) {
    throw new Error("The installment sequence is outside this plan.");
  }
  const total = weeklyUnits(plan);
  const count = BigInt(paymentCount);
  // Existing successful receipts are the accounting source of truth. This
  // also reconciles the rounding of plans started before this implementation.
  if (sequence > 0) {
    const paid = new Map();
    for (const attempt of Object.values(plan.attempts || {})) {
      if (attempt.status !== "validated_success" || attempt.sequence >= sequence) continue;
      if (paid.has(attempt.sequence)) throw new Error("Duplicate successful receipts need review before this plan can continue.");
      paid.set(attempt.sequence, amountUnits(attempt.amount));
    }
    if (paid.size !== sequence) {
      throw new Error("This older plan has incomplete payment evidence. Pause it and create a new plan for the remaining amount after reviewing wallet history.");
    }
    const remaining = total - [...paid.values()].reduce((sum, value) => sum + value, 0n);
    const remainingCount = BigInt(paymentCount - sequence);
    const units = remaining / remainingCount + (remaining % remainingCount > 0n ? 1n : 0n);
    if (units <= 0n) throw new Error("The remaining plan balance cannot support this interval. Review the plan before continuing.");
    return unitsAmount(units);
  }
  // Spread rounding units over the earliest installments; the sum is exact.
  const units = total / count + (BigInt(sequence) < total % count ? 1n : 0n);
  if (units <= 0n) throw new Error("This interval produces a zero payment. Increase the amount or choose a longer interval.");
  return unitsAmount(units);
}
