import { describe, expect, it } from "vitest";
import { amountUnits, installmentAmount, weeklyUnits } from "./amounts.js";
import { getSchedule } from "./schedule.js";

function payWholePlan(plan) {
  const count = getSchedule(plan).payments;
  let paid = 0n;
  for (let sequence = 0; sequence < count; sequence++) {
    const amount = installmentAmount(plan, sequence, count);
    paid += amountUnits(amount);
    plan.attempts[`${sequence}`] = { sequence, status: "validated_success", amount };
  }
  return paid;
}

describe("exact RLUSD accounting", () => {
  it.each(["hour", "day"])("pays exactly $2,600 at the %s interval", (frequency) => {
    const plan = { weeklyPay: "2600", frequency, attempts: {} };
    expect(payWholePlan(plan)).toBe(2_600_000_000n);
  });
  it("distributes a 15-second plan in micro-units rather than rounded floats", () => {
    const plan = { weeklyPay: "2600", frequency: "seconds15" };
    expect(installmentAmount(plan, 0, 40320)).toBe("0.064485");
    expect(weeklyUnits(plan)).toBe(2_600_000_000n);
  });
  it("reconciles the full 40,320-payment rounding regression in the final installment", () => {
    const attempts = Object.fromEntries(Array.from({ length: 40319 }, (_, sequence) => [
      sequence, { sequence, status: "validated_success", amount: "0.064484" },
    ]));
    const last = installmentAmount({ weeklyPay: "2600", attempts }, 40319, 40320);
    expect(40319n * amountUnits("0.064484") + amountUnits(last)).toBe(2_600_000_000n);
  });
  it("corrects earlier rounding using actual successful receipts", () => {
    const plan = { weeklyPay: "1", frequency: "day", attempts: {
      one: { sequence: 0, status: "validated_success", amount: "0.142857" },
      two: { sequence: 1, status: "validated_success", amount: "0.142857" },
    } };
    let paid = 285714n;
    for (let sequence = 2; sequence < 7; sequence++) {
      const amount = installmentAmount(plan, sequence, 7);
      paid += amountUnits(amount);
      plan.attempts[sequence] = { sequence, status: "validated_success", amount };
    }
    expect(paid).toBe(1_000_000n);
  });
  it("rejects incomplete prior evidence and zero/overpaid schedules", () => {
    expect(() => installmentAmount({ weeklyPay: "7" }, 2, 7)).toThrow("incomplete payment evidence");
    expect(() => installmentAmount({ weeklyPay: "0" }, 0, 7)).toThrow("zero payment");
    expect(() => installmentAmount({ weeklyPay: "1", attempts: { a: { sequence: 0, status: "validated_success", amount: "2" } } }, 1, 7)).toThrow("remaining plan balance");
  });
  it("multiplies fractional hourly rates exactly and rejects invalid precision", () => {
    expect(weeklyUnits({ payMode: "hourly", hourlyPay: "32.50", hoursPerWeek: "40.25" })).toBe(1_308_125_000n);
    for (const value of ["-1", "Infinity", "1e3", "1.0000001", "oops"]) expect(() => amountUnits(value)).toThrow();
  });
});
