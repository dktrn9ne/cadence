import { describe, expect, it } from "vitest";
import { mergePlanEdit } from "./planEdits.js";

const base = { id: "plan", address: "rRecipient", payer: "rPayer", weeklyPay: "7", payMode: "weekly", hourlyPay: "0", hoursPerWeek: "0", frequency: "day", attempts: {}, paidCount: 0, active: false, nextRunAt: null };
describe("editing live plans", () => {
  it("keeps a late payment/attempt when an older editor draft changes only a label", () => {
    const current = { ...base, paidCount: 1, active: true, nextRunAt: 1234, attempts: { payment: { sequence: 0, status: "validated_success" } } };
    const edited = mergePlanEdit({ ...base, name: "Updated name" }, current, "rPayer");
    expect(edited.name).toBe("Updated name");
    expect(edited.paidCount).toBe(1);
    expect(edited.attempts).toEqual(current.attempts);
    expect(edited.active).toBe(true);
    expect(edited.nextRunAt).toBe(1234);
  });
  it("blocks term changes during a queued start and after any attempt", () => {
    for (const current of [{ ...base, active: true }, { ...base, attempts: { pending: { status: "unresolved" } } }]) {
      expect(() => mergePlanEdit({ ...base, weeklyPay: "8" }, current, "rPayer")).toThrow("Payment terms are locked");
    }
  });
  it("allows new terms before the plan starts and preserves the live inactive state", () => {
    const edited = mergePlanEdit({ ...base, weeklyPay: "8", active: true }, base, "rNewPayer");
    expect(edited.weeklyPay).toBe("8"); expect(edited.payer).toBe("rNewPayer"); expect(edited.active).toBe(false);
  });
});
