// planState hardening tests: integrity checksum, quarantine, and the
// load/write status channel that the durable-payments hook folds into the
// storage banner and dispatch gate. Fixtures only — never a live seed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgePlanStateIssue,
  getPlanStateStatus,
  loadPlans,
  flushPlans,
  recordAttempt,
  savePlans,
  subscribePlanStateStatus,
} from "./planState.js";

const STORAGE_KEY = "cadence-plans-v1";
const QUARANTINE_KEY = "cadence-plans-v1.quarantine";
const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DEST = "rFixtur3DestAcct11111111111111111111";

const planFixture = (overrides = {}) => ({
  id: "person-1734",
  name: "Fixture Person",
  role: "",
  email: "",
  payMode: "weekly",
  weeklyPay: "16",
  hourlyPay: "0",
  hoursPerWeek: "0",
  frequency: "minute",
  active: true,
  paidCount: 3,
  nextRunAt: 1_760_002_206_000,
  payer: PAYER,
  destination: DEST,
  attempts: {},
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
  acknowledgePlanStateIssue();
});

describe("checksum integrity", () => {
  it("round-trips a checksummed envelope", () => {
    savePlans([planFixture()]);
    flushPlans();
    expect(loadPlans()).toEqual([planFixture()]);
    expect(getPlanStateStatus().state).toBe("ready");
  });

  it("quarantines a tampered envelope instead of trusting it", () => {
    savePlans([planFixture()]);
    flushPlans();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    stored.plans[0].paidCount = 99; // tampering
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    expect(loadPlans()).toEqual([]);
    expect(getPlanStateStatus().state).toBe("corrupt");

    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.reason).toBe("checksum_mismatch");
    expect(JSON.parse(quarantined.raw).plans[0].paidCount).toBe(99);
  });

  it("accepts legacy envelopes written before the checksum existed", () => {
    // A pre-hardening payload has no checksum field — it must still load.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, savedAt: 1, plans: [planFixture()] }),
    );
    expect(loadPlans()).toEqual([planFixture()]);
  });
});

describe("quarantine on unreadable payloads", () => {
  it("quarantines unparseable JSON, starts empty, and publishes corrupt", () => {
    localStorage.setItem(STORAGE_KEY, "{not json at all");
    expect(loadPlans()).toEqual([]);
    expect(getPlanStateStatus().state).toBe("corrupt");

    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.raw).toBe("{not json at all");
    expect(quarantined.reason).toBe("unparseable_json");
    expect(typeof quarantined.quarantinedAt).toBe("string");
  });

  it("quarantines an unknown version — never guessed at or downgraded", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 999, savedAt: 1, plans: [planFixture()] }),
    );
    expect(loadPlans()).toEqual([]);
    expect(getPlanStateStatus().state).toBe("unknown_version");

    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.reason).toBe("unknown_version");
    expect(quarantined.version).toBe(999);
  });

  it("acknowledgement clears the halt and the quarantined payload stays", () => {
    localStorage.setItem(STORAGE_KEY, "{nope");
    loadPlans();
    expect(getPlanStateStatus().state).toBe("corrupt");

    acknowledgePlanStateIssue();
    expect(getPlanStateStatus().state).toBe("ready");
    expect(localStorage.getItem(QUARANTINE_KEY)).not.toBeNull();
  });
});

describe("invalid rows excluded but preserved", () => {
  it("loads valid plans and reports the dropped count", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        plans: [planFixture(), null, "junk", { id: "", name: "no identity" }],
      }),
    );
    expect(loadPlans()).toEqual([planFixture()]);
    const status = getPlanStateStatus();
    expect(status.state).toBe("invalid_rows");
    // null, "junk", and the identity-less object are the three dropped rows.
    expect(status.message).toContain("3 stored plans");
  });
});

describe("write failure status", () => {
  it("publishes write_failed on a failing write and halts the gate", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    savePlans([planFixture()]);
    flushPlans();
    spy.mockRestore();

    expect(getPlanStateStatus().state).toBe("write_failed");
    expect(getPlanStateStatus().message).toContain("not persisting");
  });

  it("clears write_failed once a write succeeds again", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    savePlans([planFixture()]);
    flushPlans();
    expect(getPlanStateStatus().state).toBe("write_failed");
    spy.mockRestore();

    savePlans([planFixture()]);
    flushPlans();
    expect(getPlanStateStatus().state).toBe("ready");
  });

  it("does not clear a quarantine status just because a write succeeded", () => {
    localStorage.setItem(STORAGE_KEY, "{nope");
    loadPlans();
    savePlans([planFixture()]);
    flushPlans();
    // A successful write is not evidence the quarantined payload was fine.
    expect(getPlanStateStatus().state).toBe("corrupt");
  });
});

describe("status channel", () => {
  it("replays the current status to a new subscriber immediately", () => {
    localStorage.setItem(STORAGE_KEY, "{nope");
    loadPlans();

    const seen = [];
    const unsubscribe = subscribePlanStateStatus((status) => seen.push(status.state));
    expect(seen).toEqual(["corrupt"]);
    unsubscribe();
  });

  it("replays current status, notifies on changes, and survives listener errors", () => {
    // Seed a failure first so the replay ('corrupt') is distinguishable from
    // the later change ('ready').
    localStorage.setItem(STORAGE_KEY, "{nope");
    loadPlans();

    const seen = [];
    const broken = vi.fn(() => {
      throw new Error("listener bug");
    });
    const unsubscribeA = subscribePlanStateStatus((status) => seen.push(status.state));
    const unsubscribeB = subscribePlanStateStatus(broken);

    acknowledgePlanStateIssue();
    expect(seen).toEqual(["corrupt", "ready"]);

    // The broken listener did not stop the healthy one.
    unsubscribeA();
    unsubscribeB();
  });

  it("records attempts with an immediate durable write", () => {
    const plans = [{ ...planFixture(), attempts: {} }];
    const next = recordAttempt(plans, "person-1734", {
      sequence: 3,
      status: "submitted",
      hash: "44F0FAKEHASH0000000000000000000000000000000000000000000000000000",
      amount: "2.666667",
    });
    expect(next).not.toBe(plans); // state changed
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(Object.keys(stored.plans[0].attempts)).toEqual(["person-1734:3"]);
    expect(getPlanStateStatus().state).toBe("ready");
  });
});
