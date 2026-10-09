// Unit tests for the pure mount-recovery rules (PR 04 wave 4).
import { describe, expect, it } from "vitest";
import { countMissedWindows, hydrateRestoredPlans, mountAttemptAction } from "./recovery.js";

describe("mountAttemptAction", () => {
  it("reconciles submitted and unresolved attempts by hash — the only exit from an unknown outcome", () => {
    for (const status of ["submitted", "unresolved"]) {
      expect(mountAttemptAction({ sequence: 2, status, hash: "HASH", submittedAt: 1 })).toBe("reconcile");
    }
  });

  it("records a failed attempt for a wallet prompt that died with the previous session", () => {
    // Nothing was submitted, so there is no hash to reconcile.
    expect(mountAttemptAction({ sequence: 2, status: "awaiting_signature", hash: null, submittedAt: 1 })).toBe("record-failed");
  });

  it("leaves terminal statuses alone", () => {
    for (const status of ["validated_success", "validated_failure"]) {
      expect(mountAttemptAction({ sequence: 2, status })).toBe("none");
    }
  });

  it("leaves unrecognized statuses alone — they keep blocking via the attempt guard (fail closed)", () => {
    expect(mountAttemptAction({ sequence: 2, status: "garbage" })).toBe("none");
    expect(mountAttemptAction(undefined)).toBe("none");
    expect(mountAttemptAction({})).toBe("none");
  });
});

describe("countMissedWindows", () => {
  const FREQ = 1000;

  it("counts every window that came due on or after nextRunAt, including one due exactly now", () => {
    const now = 1_000_000;
    expect(countMissedWindows({ nextRunAt: now, frequencyMs: FREQ, remaining: 10, now })).toBe(1);
    expect(countMissedWindows({ nextRunAt: now - 3500, frequencyMs: FREQ, remaining: 10, now })).toBe(4);
  });

  it("counts zero when the next window is still in the future", () => {
    const now = 1_000_000;
    expect(countMissedWindows({ nextRunAt: now + 1, frequencyMs: FREQ, remaining: 10, now })).toBe(0);
  });

  it("clamps to the remaining installment budget — clock drift cannot drive a plan past its total", () => {
    const now = 1_000_000;
    expect(countMissedWindows({ nextRunAt: now - 10_000, frequencyMs: FREQ, remaining: 2, now })).toBe(2);
    expect(countMissedWindows({ nextRunAt: now - 10_000, frequencyMs: FREQ, remaining: 1, now })).toBe(1);
  });

  it("counts zero for unset or malformed schedule state", () => {
    const now = 1_000_000;
    expect(countMissedWindows({ nextRunAt: null, frequencyMs: FREQ, remaining: 10, now })).toBe(0);
    expect(countMissedWindows({ nextRunAt: "soon", frequencyMs: FREQ, remaining: 10, now })).toBe(0);
    expect(countMissedWindows({ nextRunAt: now, frequencyMs: 0, remaining: 10, now })).toBe(0);
    expect(countMissedWindows({ nextRunAt: now, frequencyMs: FREQ, remaining: 0, now })).toBe(0);
    expect(countMissedWindows({ nextRunAt: now, frequencyMs: FREQ, remaining: -1, now })).toBe(0);
  });
});

describe("hydrateRestoredPlans", () => {
  it("maps the persisted destination onto the dashboard's address field and stamps the recovered flag", () => {
    const plans = hydrateRestoredPlans([
      {
        id: "person-1",
        payer: "rPayer",
        destination: "rEmployee",
        paidCount: 2,
        nextRunAt: 123,
        active: true,
        name: "Riley",
        frequency: "day",
        weeklyPay: "7",
        attempts: {},
      },
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].address).toBe("rEmployee");
    expect(plans[0].recovered).toBe(true);
    expect(plans[0].paidCount).toBe(2);
    expect(plans[0].attempts).toEqual({});
  });

  it("fills neutral defaults for fields an older envelope lacks — never an invented pay rate", () => {
    const plans = hydrateRestoredPlans([{ id: "person-1", destination: "rEmployee" }]);
    expect(plans[0].name).toBe("");
    expect(plans[0].weeklyPay).toBe("0");
    expect(plans[0].frequency).toBe("minute");
    expect(plans[0].payMode).toBe("weekly");
  });

  it("keeps stored values when present — defaults never overwrite what was persisted", () => {
    const plans = hydrateRestoredPlans([{ id: "person-1", name: "Riley", frequency: "hour", weeklyPay: "16" }]);
    expect(plans[0].name).toBe("Riley");
    expect(plans[0].frequency).toBe("hour");
    expect(plans[0].weeklyPay).toBe("16");
  });

  it("drops entries without an id and tolerates non-arrays", () => {
    expect(hydrateRestoredPlans([null, "junk", {}, { id: "" }])).toEqual([]);
    expect(hydrateRestoredPlans(undefined)).toEqual([]);
  });
});
