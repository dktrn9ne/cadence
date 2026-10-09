import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAttempt,
  flushPlans,
  loadPlans,
  recordAttempt,
  savePlans,
} from "./planState.js";

// The storage key is pinned literally so a rename or version bump in the
// module cannot silently desync from these tests.
const STORAGE_KEY = "cadence-plans-v1";
const PLAN_ID = "person-1760000000000";
const INSTALLMENT_KEY = `${PLAN_ID}:2`;

const basePlan = {
  id: PLAN_ID,
  payer: "rPayerAccountXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  destination: "rEmployeeAccountXXXXXXXXXXXXXXXXXX",
  paidCount: 2,
  nextRunAt: 1760003600000,
  active: true,
  attempts: {},
};

const allowlistedPlan = {
  id: PLAN_ID,
  payer: basePlan.payer,
  destination: basePlan.destination,
  paidCount: 2,
  nextRunAt: 1760003600000,
  active: true,
  attempts: {},
};

const readStored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY));

beforeEach(() => {
  window.localStorage.clear();
  flushPlans();
});

afterEach(() => {
  flushPlans();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("planState round-trip", () => {
  it("persists an allowlisted plan and restores it verbatim", () => {
    savePlans([basePlan]);
    flushPlans();
    expect(loadPlans()).toEqual([allowlistedPlan]);
  });

  it("restores multiple plans with a partially-filled attempt ledger", () => {
    const withAttempt = {
      ...basePlan,
      attempts: {
        [INSTALLMENT_KEY]: {
          sequence: 2,
          status: "submitted",
          hash: "9A4C4A6C2B21F5E8D3A0C4B21F5E8D3A0C4B21F5E8D3A0C4B21F5E8D3A0C4B2",
          submittedAt: 1760000001234,
          amount: "4.000000",
        },
      },
    };
    savePlans([{ ...basePlan, id: "person-1", active: false, paidCount: 0, nextRunAt: null }, withAttempt]);
    flushPlans();
    expect(loadPlans()).toEqual([
      { ...allowlistedPlan, id: "person-1", active: false, paidCount: 0, nextRunAt: null },
      { ...allowlistedPlan, attempts: withAttempt.attempts },
    ]);
  });

  it("returns no plans when nothing was stored", () => {
    expect(loadPlans()).toEqual([]);
  });

  it("re-keys stored attempts onto the deterministic installment id", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1760000000000,
        plans: [
          {
            ...allowlistedPlan,
            attempts: {
              "drifted-key": { sequence: 2, status: "submitted", hash: "HASH", submittedAt: 5, amount: "4.000000" },
            },
          },
        ],
      })
    );
    const plans = loadPlans();
    expect(Object.keys(plans[0].attempts)).toEqual([INSTALLMENT_KEY]);
  });
});

describe("planState malformed or unknown storage", () => {
  it("returns safe defaults for garbage JSON without throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json at all");
    expect(loadPlans()).toEqual([]);
  });

  it("returns safe defaults for an unknown version", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 999, savedAt: 1, plans: [allowlistedPlan] })
    );
    expect(loadPlans()).toEqual([]);
  });

  it("returns safe defaults for non-object payloads", () => {
    for (const raw of ["42", '"a string"', "null", "[1,2,3]"]) {
      window.localStorage.setItem(STORAGE_KEY, raw);
      expect(loadPlans()).toEqual([]);
    }
  });

  it("returns safe defaults when plans is not an array", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, plans: "nope" }));
    expect(loadPlans()).toEqual([]);
  });

  it("keeps valid plans and drops corrupt entries in the same array", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, savedAt: 1, plans: [allowlistedPlan, null, "junk", 7, {}] })
    );
    expect(loadPlans()).toEqual([allowlistedPlan]);
  });

  it("coerces hostile field types into safe defaults instead of throwing", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        plans: [{ id: PLAN_ID, paidCount: "lots", nextRunAt: "soon", active: "yes", payer: 42, destination: null }],
      })
    );
    expect(loadPlans()).toEqual([
      {
        id: PLAN_ID,
        payer: "",
        destination: "",
        paidCount: 0,
        nextRunAt: null,
        active: false,
        attempts: {},
      },
    ]);
  });
});

describe("planState secret-material pollution", () => {
  it("never persists plan fields outside the allowlist, even secret-shaped ones", () => {
    const polluted = {
      ...basePlan,
      seed: "sEdSuperSecretSeedMaterial",
      mnemonic: "word word word word word",
      privateKey: "0xdeadbeef",
      master_seed: "SHABeefCafe",
      walletPassword: "hunter2",
      signedTxBlob: "7C0A9E01",
    };
    savePlans([polluted]);
    flushPlans();

    const stored = readStored();
    expect(Object.keys(stored.plans[0])).toEqual([
      "id",
      "payer",
      "destination",
      "paidCount",
      "nextRunAt",
      "active",
      "attempts",
    ]);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    for (const secret of ["sEdSuperSecretSeedMaterial", "0xdeadbeef", "SHABeefCafe", "hunter2", "7C0A9E01"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("never persists attempt fields outside the allowlist", () => {
    const next = recordAttempt([basePlan], PLAN_ID, {
      sequence: 2,
      status: "submitted",
      hash: "HASH",
      submittedAt: 1760000001234,
      amount: "4.000000",
      signedTxBlob: "7C0A9E01BLOB",
      seed: "sEdAttemptSeed",
    });
    flushPlans();

    const stored = readStored();
    expect(Object.keys(stored.plans[0].attempts[INSTALLMENT_KEY])).toEqual([
      "sequence",
      "status",
      "hash",
      "submittedAt",
      "amount",
    ]);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("7C0A9E01BLOB");
    expect(Object.keys(next[0].attempts[INSTALLMENT_KEY])).toEqual([
      "sequence",
      "status",
      "hash",
      "submittedAt",
      "amount",
    ]);
  });
});

describe("recordAttempt", () => {
  it("upserts under the deterministic key and persists immediately (no flush, no timers)", () => {
    const attempt = { sequence: 2, status: "submitted", hash: "HASH", submittedAt: 1760000001234, amount: "4.000000" };
    const next = recordAttempt([basePlan], PLAN_ID, attempt);

    expect(next[0].attempts[INSTALLMENT_KEY]).toEqual(attempt);
    // Immediate persist: storage already holds the attempt without flushPlans.
    expect(readStored().plans[0].attempts[INSTALLMENT_KEY]).toEqual(attempt);
  });

  it("does not mutate the input array (pure update)", () => {
    const attempt = { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: 1, amount: "" };
    const frozen = [basePlan];
    recordAttempt(frozen, PLAN_ID, attempt);
    expect(frozen[0].attempts).toEqual({});
  });

  it("replaces an existing attempt for the same installment id", () => {
    let plans = [basePlan];
    plans = recordAttempt(plans, PLAN_ID, { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: 1, amount: "" });
    plans = recordAttempt(plans, PLAN_ID, { sequence: 2, status: "submitted", hash: "HASH", submittedAt: 2, amount: "4.000000" });
    expect(Object.keys(plans[0].attempts)).toEqual([INSTALLMENT_KEY]);
    expect(plans[0].attempts[INSTALLMENT_KEY].status).toBe("submitted");
    expect(readStored().plans[0].attempts[INSTALLMENT_KEY].hash).toBe("HASH");
  });

  it("returns the same array reference when the plan is unknown", () => {
    const plans = [basePlan];
    expect(recordAttempt(plans, "person-unknown", { sequence: 2, status: "submitted" })).toBe(plans);
  });

  it("returns the same array reference when the attempt has no valid sequence", () => {
    const plans = [basePlan];
    expect(recordAttempt(plans, PLAN_ID, { sequence: "due" })).toBe(plans);
    expect(recordAttempt(plans, PLAN_ID, null)).toBe(plans);
  });

  it("records a hash-less failure (rejected signing) without advancing anything", () => {
    // The storage layer records exactly what it is told; whether paidCount
    // advances is the state machine's decision (sibling PR).
    const next = recordAttempt([basePlan], PLAN_ID, {
      sequence: 3,
      status: "validated_failure",
      hash: null,
      submittedAt: 5,
      amount: "4.000000",
    });
    expect(next[0].attempts[`${PLAN_ID}:3`]).toEqual({
      sequence: 3,
      status: "validated_failure",
      hash: null,
      submittedAt: 5,
      amount: "4.000000",
    });
    expect(next[0].paidCount).toBe(2); // untouched by storage
  });
});

describe("applyAttempt (pure core)", () => {
  it("returns a new array without touching storage", () => {
    const next = applyAttempt([basePlan], PLAN_ID, { sequence: 1, status: "awaiting_signature", hash: null });
    expect(Object.keys(next[0].attempts)).toEqual([`${PLAN_ID}:1`]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("preserves sibling plans and their attempts", () => {
    const other = { ...basePlan, id: "person-other", attempts: { "person-other:7": { sequence: 7, status: "unresolved", hash: "H", submittedAt: 9, amount: "1.000000" } } };
    const next = applyAttempt([basePlan, other], "person-other", { sequence: 8, status: "submitted", hash: "H2", submittedAt: 10, amount: "1.000000" });
    expect(next[1].attempts["person-other:7"]).toEqual({ sequence: 7, status: "unresolved", hash: "H", submittedAt: 9, amount: "1.000000" });
    expect(next[1].attempts["person-other:8"].hash).toBe("H2");
    expect(next[0]).toEqual(allowlistedPlan);
  });
});

describe("debounced persistence", () => {
  it("coalesces rapid saves: each save resets the window, nothing lands early", () => {
    vi.useFakeTimers();

    savePlans([{ ...basePlan, id: "person-a" }]);
    vi.advanceTimersByTime(200); // inside the first window
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    savePlans([{ ...basePlan, id: "person-b" }]); // resets the debounce window
    vi.advanceTimersByTime(200); // 400ms since the first save, only 200 since the reset
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    vi.advanceTimersByTime(200); // 400ms since the last save — past the window
    expect(loadPlans().map((plan) => plan.id)).toEqual(["person-b"]);
  });

  it("flushPlans lands the pending envelope without waiting for the timer", () => {
    vi.useFakeTimers();
    savePlans([basePlan]);
    flushPlans();
    expect(loadPlans()).toEqual([allowlistedPlan]);
    // The timer, when it eventually fires, finds nothing pending.
    vi.advanceTimersByTime(1000);
    expect(loadPlans()).toEqual([allowlistedPlan]);
  });

  it("ignores a non-array argument instead of wiping stored state", () => {
    savePlans([basePlan]);
    flushPlans();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    savePlans(undefined);
    flushPlans();
    expect(loadPlans()).toEqual([allowlistedPlan]);
    expect(warn).toHaveBeenCalled();
  });

  it("a recordAttempt immediately after savePlans cancels the stale pending write", () => {
    vi.useFakeTimers();
    savePlans([{ ...basePlan, paidCount: 2 }]);
    const next = recordAttempt([{ ...basePlan, paidCount: 2 }], PLAN_ID, {
      sequence: 2,
      status: "submitted",
      hash: "HASH",
      submittedAt: 3,
      amount: "4.000000",
    });
    // The immediate write already includes the attempt...
    expect(readStored().plans[0].attempts[INSTALLMENT_KEY].hash).toBe("HASH");
    // ...and when the old debounce fires it must not clobber it with a
    // stale attempt-less envelope.
    vi.advanceTimersByTime(1000);
    expect(loadPlans()).toEqual(next);
  });
});

// Ported from main's superseded attemptStore.test.js (PR #11, unwired).
// attemptStore REFUSED these inputs by throwing; this store's contract is
// never-throw allowlist coercion, so the same cases are pinned as scrubbing
// and type pins instead of exceptions. The safety property is identical: no
// secret-shaped key and no non-string amount ever reaches persisted bytes.
describe("ported from attemptStore: secret-shaped keys and amount typing", () => {
  // attemptStore's exact key filter: /seed|phrase|secret|password|mnemonic|
  // private[\s_-]?key|accessinput/i — the separator shapes it says a name
  // filter historically misses are included on purpose.
  const SECRET_SHAPED = /seed|phrase|secret|password|mnemonic|private[\s_-]?key|accessinput/i;
  const SECRET_KEYS = [
    "mnemonic",
    "seed",
    "master_seed",
    "passphrase",
    "account_secret",
    "private_key",
    "private-key",
    "private key",
    "accessInput",
  ];
  const FAKE_VALUE = (key) => `fixture-not-a-real-${key.toLowerCase().replace(/\s+/g, "-")}`;

  it("scrubs every secret-shaped key name from attempts, across all separator shapes", () => {
    for (const key of SECRET_KEYS) {
      expect(SECRET_SHAPED.test(key)).toBe(true); // the filter must catch every name below
    }
    const pollutedAttempt = {
      sequence: 2,
      status: "submitted",
      hash: "HASH",
      submittedAt: 1,
      amount: "4.000000",
      ...Object.fromEntries(SECRET_KEYS.map((key) => [key, FAKE_VALUE(key)])),
    };
    const next = recordAttempt([basePlan], PLAN_ID, pollutedAttempt);
    flushPlans();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = next[0].attempts[INSTALLMENT_KEY];
    for (const key of SECRET_KEYS) {
      expect(Object.keys(stored)).not.toContain(key);
      expect(raw).not.toContain(FAKE_VALUE(key));
    }
    // The durability-critical fields survive the scrub untouched.
    expect(stored.status).toBe("submitted");
    expect(stored.hash).toBe("HASH");
  });

  it("scrubs every secret-shaped key name from plans, across all separator shapes", () => {
    const polluted = {
      ...basePlan,
      ...Object.fromEntries(SECRET_KEYS.map((key) => [key, FAKE_VALUE(key)])),
    };
    savePlans([polluted]);
    flushPlans();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = readStored().plans[0];
    for (const key of SECRET_KEYS) {
      expect(Object.keys(stored)).not.toContain(key);
      expect(raw).not.toContain(FAKE_VALUE(key));
    }
    expect(Object.keys(stored)).toEqual([
      "id",
      "payer",
      "destination",
      "paidCount",
      "nextRunAt",
      "active",
      "attempts",
    ]);
  });

  it("persists amounts as strings only — hostile amounts never land as JSON numbers, and the attempt survives", () => {
    // attemptStore refused these with /exact decimal string/; here the
    // display-only amount is coerced to a string and the durability-critical
    // attempt record is never dropped. A float must never reach storage as a
    // number — that is the invariant behind the decimal-string rule.
    const hostile = [12.5, "12,50", "1e3", "-1", ".5", "12.5.0", null, undefined];
    let plans = [basePlan];
    hostile.forEach((amount, i) => {
      plans = recordAttempt(plans, PLAN_ID, {
        sequence: i,
        status: "submitted",
        hash: "HASH",
        submittedAt: i,
        amount,
      });
      expect(plans[0].attempts[`${PLAN_ID}:${i}`]).toBeDefined();
    });
    flushPlans();
    for (const plan of readStored().plans) {
      for (const stored of Object.values(plan.attempts)) {
        expect(typeof stored.amount).toBe("string");
        // Unquoted JSON number = a float landed in storage. Never.
        expect(JSON.stringify(stored)).not.toMatch(/"amount":\s*-?\d/);
      }
    }
    // A canonical exact decimal string round-trips verbatim.
    const canonical = recordAttempt([basePlan], PLAN_ID, {
      sequence: 9,
      status: "submitted",
      hash: "HASH",
      submittedAt: 9,
      amount: "12.5000",
    });
    expect(canonical[0].attempts[`${PLAN_ID}:9`].amount).toBe("12.5000");
  });
});
