import { describe, expect, it } from "vitest";
import { FREQUENCIES, TIME_UNITS, getFrequencyMs, getSchedule } from "../src/domain/schedule.js";

describe("getSchedule", () => {
  it("divides weekly pay across the payments in one week", () => {
    const schedule = getSchedule({ weeklyPay: "16", frequency: "minute" });

    expect(schedule.payMode).toBe("weekly");
    expect(schedule.weeklyPay).toBe(16);
    expect(schedule.payments).toBe(Math.floor(TIME_UNITS.week.seconds / TIME_UNITS.minute.seconds));
    expect(schedule.perPayment).toBe(16 / 10080);
    expect(schedule.frequencyLabel).toBe("1 minute");
    expect(schedule.frequencySeconds).toBe(60);
  });

  it("derives the weekly total from hourly pay and hours per week", () => {
    const schedule = getSchedule({
      payMode: "hourly",
      hourlyPay: "20",
      hoursPerWeek: "40",
      frequency: "day",
    });

    expect(schedule.weeklyPay).toBe(800);
    expect(schedule.payments).toBe(7);
    expect(schedule.perPayment).toBe(800 / 7);
  });

  it("falls back to the amount field when weeklyPay is missing", () => {
    const schedule = getSchedule({ amount: "12", frequency: "hour" });

    expect(schedule.weeklyPay).toBe(12);
    expect(schedule.payments).toBe(168);
    expect(schedule.perPayment).toBe(12 / 168);
  });

  it("clamps negative and non-numeric pay to zero", () => {
    expect(getSchedule({ weeklyPay: "-5", frequency: "day" }).weeklyPay).toBe(0);
    expect(getSchedule({ weeklyPay: "not-a-number", frequency: "day" }).weeklyPay).toBe(0);
    expect(getSchedule({ payMode: "hourly", hourlyPay: "-3", hoursPerWeek: "40", frequency: "day" }).weeklyPay).toBe(0);
    expect(getSchedule({ payMode: "hourly", hourlyPay: "20", hoursPerWeek: "-2", frequency: "day" }).weeklyPay).toBe(0);
  });

  it("never schedules fewer than one payment per week", () => {
    const schedule = getSchedule({ weeklyPay: "100", frequency: "week" });

    expect(schedule.payments).toBe(1);
    expect(schedule.perPayment).toBe(100);
  });

  it("falls back to the one-minute frequency for unknown keys", () => {
    const schedule = getSchedule({ weeklyPay: "60", frequency: "fortnight" });

    expect(schedule.frequencyLabel).toBe("1 minute");
    expect(schedule.frequencySeconds).toBe(60);
    expect(schedule.payments).toBe(10080);
    expect(getFrequencyMs({ frequency: "fortnight" })).toBe(60000);
  });

  it("exposes the same per-payment value as totalPerPayment", () => {
    const schedule = getSchedule({ weeklyPay: "16", frequency: "seconds15" });

    expect(schedule.totalPerPayment).toBe(schedule.perPayment);
    expect(schedule.weeklyEquivalent).toBe(schedule.weeklyPay);
  });
});

describe("getFrequencyMs", () => {
  it("converts each frequency to milliseconds", () => {
    expect(getFrequencyMs({ frequency: "seconds15" })).toBe(15000);
    expect(getFrequencyMs({ frequency: "seconds30" })).toBe(30000);
    expect(getFrequencyMs({ frequency: "minute" })).toBe(60000);
    expect(getFrequencyMs({ frequency: "minutes5" })).toBe(300000);
    expect(getFrequencyMs({ frequency: "minutes15" })).toBe(900000);
    expect(getFrequencyMs({ frequency: "hour" })).toBe(3600000);
    expect(getFrequencyMs({ frequency: "day" })).toBe(86400000);
  });
});

describe("frequency tables", () => {
  it("keeps every schedulable frequency inside TIME_UNITS", () => {
    for (const key of FREQUENCIES) {
      expect(TIME_UNITS[key]).toBeTruthy();
      expect(TIME_UNITS[key].seconds).toBeGreaterThan(0);
    }
    expect(FREQUENCIES).not.toContain("week");
  });
});
