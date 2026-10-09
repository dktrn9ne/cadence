// Unit tests for the pure mount-recovery rules (PR 04 wave 4, audit-fix
// revision per art_FIvT05e6).
import { describe, expect, it } from "vitest";
import { ATTEMPT_STALE_MS, countMissedWindows, hydrateRestoredPlans, mountAttemptAction } from "./recovery.js";

describe("mountAttemptAction", () => {
  it("reconciles submitted and unresolved attempts by hash — the only exit from an unknown outcome", () => {
    for (const status of ["submitted", "unresolved"]) {
      expect(mountAttemptAction({ sequence: 2, status, hash: "HASH", submittedAt: 1 })).toBe("reconcile");
    }
  });

  it("on a mount, a wallet prompt that died with the previous session always parks unresolved", () => {
    // Nothing proves the submission did not happen, so there is no retryable
    // state — no hash to reconcile either. Freshness is irrelevant: every
    // record a mount sees belongs to a dead session (audit violation 2).
    const now = 1_000_000;
    expect(
      mountAttemptAction({ sequence: 2, status: "awaiting_signature", hash: null, submittedAt: now }, { now })
    ).toBe("record-unresolved");
    expect(
      mountAttemptAction(
        { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: now - ATTEMPT_STALE_MS - 1 },
        { now }
      )
    ).toBe("record-unresolved");
  });

  it("on a live tick, a fresh awaiting_signature stays owned by its dispatcher — never expired mid-prompt", () => {
    const now = 1_000_000;
    expect(
      mountAttemptAction(
        { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: now - 1000 },
        { now, live: true }
      )
    ).toBe("none");
    // Exactly at the staleness boundary it is still live — only strictly
    // older records expire.
    expect(
      mountAttemptAction(
        { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: now - ATTEMPT_STALE_MS },
        { now, live: true }
      )
    ).toBe("none");
  });

  it("on a live tick, an awaiting_signature that outlived its staleness window parks unresolved", () => {
    const now = 1_000_000;
    // A crashed or hung prompt: the dispatcher is gone, submission state is
    // unknowable — expired to unresolved (blocked, surfaced), never to the
    // retryable validated_failure state.
    expect(
      mountAttemptAction(
        { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: now - ATTEMPT_STALE_MS - 1 },
        { now, live: true }
      )
    ).toBe("record-unresolved");
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
