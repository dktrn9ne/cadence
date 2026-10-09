import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAttempt,
  attemptKey,
  flushPlans,
  latestAttemptFor,
  loadPlans,
  recordAttempt,
  savePlans,
} from "./planState.js";

// The storage key is pinned literally so a rename or version bump in the
// module cannot silently desync from these tests.
const STORAGE_KEY = "cadence-plans-v1";
const PLAN_ID = "person-1760000000000";
// Attempts are numbered per installment: the canonical key for the first
// attempt of sequence 2.
const INSTALLMENT_KEY = attemptKey(PLAN_ID, 2, 1);

const basePlan = {
  id: PLAN_ID,
  payer: "rPayerAccountXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  destination: "rEmployeeAccountXXXXXXXXXXXXXXXXXX",
  paidCount: 2,
  nextRunAt: 1760003600000,
  active: true,
  name: "Riley",
  role: "Designer",
  email: "riley@example.com",
  payMode: "weekly",
  weeklyPay: "16",
  hourlyPay: "0",
  hoursPerWeek: "0",
  frequency: "day",
  attempts: {},
};

const allowlistedPlan = {
  id: PLAN_ID,
  payer: basePlan.payer,
  destination: basePlan.destination,
  paidCount: 2,
  nextRunAt: 1760003600000,
  active: true,
  name: "Riley",
  role: "Designer",
  email: "riley@example.com",
  payMode: "weekly",
  weeklyPay: "16",
  hourlyPay: "0",
  hoursPerWeek: "0",
  frequency: "day",
  attempts: {},
};

// The persisted key order the allowlist emits — pinned so an accidental
// reshuffle of the closed shape surfaces in review instead of in production.
const PERSISTED_PLAN_KEYS = [
  "id",
  "payer",
  "destination",
  "paidCount",
  "nextRunAt",
  "active",
  "name",
  "role",
  "email",
  "payMode",
  "weeklyPay",
  "hourlyPay",
  "hoursPerWeek",
  "frequency",
  "attempts",
];

// The persisted attempt shape: identity fields (payer/destination/amount)
// feed the reconciler's match; attemptNo carries the per-installment retry
// number so history is append-only.
const PERSISTED_ATTEMPT_KEYS = [
  "sequence",
  "status",
  "hash",
  "submittedAt",
  "amount",
  "payer",
  "destination",
  "attemptNo",
];

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
          payer: basePlan.payer,
          destination: basePlan.destination,
          attemptNo: 1,
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

  it("re-keys stored attempts onto the deterministic per-attempt id", () => {
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
        name: "",
        role: "",
        email: "",
        payMode: "",
        weeklyPay: "",
        hourlyPay: "",
        hoursPerWeek: "",
        frequency: "",
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
    expect(Object.keys(stored.plans[0])).toEqual(PERSISTED_PLAN_KEYS);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    for (const secret of ["sEdSuperSecretSeedMaterial", "0xdeadbeef", "SHABeefCafe", "hunter2", "7C0A9E01"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("never persists session-only recovery fields (catch-up approval is re-derived at mount)", () => {
    const sessionMarked = {
      ...basePlan,
      catchUpPending: true,
      missedCount: 3,
      recovered: true,
    };
    savePlans([sessionMarked]);
    flushPlans();
    const stored = readStored().plans[0];
    expect(Object.keys(stored)).toEqual(PERSISTED_PLAN_KEYS);
    expect(stored.catchUpPending).toBeUndefined();
    expect(stored.missedCount).toBeUndefined();
    expect(stored.recovered).toBeUndefined();
  });

  it("never persists attempt fields outside the allowlist", () => {
    const result = recordAttempt([basePlan], PLAN_ID, {
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
    expect(Object.keys(stored.plans[0].attempts[INSTALLMENT_KEY])).toEqual(PERSISTED_ATTEMPT_KEYS);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("7C0A9E01BLOB");
    expect(Object.keys(result.plans[0].attempts[INSTALLMENT_KEY])).toEqual(PERSISTED_ATTEMPT_KEYS);
  });
});

describe("recordAttempt", () => {
  it("upserts under the deterministic per-attempt key and persists immediately (no flush, no timers)", () => {
    const attempt = {
      sequence: 2,
      status: "submitted",
      hash: "HASH",
      submittedAt: 1760000001234,
      amount: "4.000000",
      payer: basePlan.payer,
      destination: basePlan.destination,
      attemptNo: 1,
    };
    const result = recordAttempt([basePlan], PLAN_ID, attempt);

    expect(result.persisted).toBe(true);
    expect(result.plans[0].attempts[INSTALLMENT_KEY]).toEqual(attempt);
    // Immediate persist: storage already holds the attempt without flushPlans.
    expect(readStored().plans[0].attempts[INSTALLMENT_KEY]).toEqual(attempt);
  });

  it("defaults attemptNo to 1 and fills identity fields with safe defaults", () => {
    const result = recordAttempt([basePlan], PLAN_ID, { sequence: 2, status: "submitted", hash: "HASH" });
    expect(result.plans[0].attempts[INSTALLMENT_KEY]).toEqual({
      sequence: 2,
      status: "submitted",
      hash: "HASH",
      submittedAt: null,
      amount: "",
      payer: "",
      destination: "",
      attemptNo: 1,
    });
  });

  it("does not mutate the input array (pure update)", () => {
    const attempt = { sequence: 2, status: "awaiting_signature", hash: null, submittedAt: 1, amount: "" };
    const frozen = [basePlan];
    recordAttempt(frozen, PLAN_ID, attempt);
    expect(frozen[0].attempts).toEqual({});
  });

  it("numbers each retry its own record instead of overwriting history (audit violation 4)", () => {
    let result = recordAttempt([basePlan], PLAN_ID, {
      sequence: 2, status: "awaiting_signature", hash: null, submittedAt: 1, amount: "4.000000",
      payer: basePlan.payer, destination: basePlan.destination, attemptNo: 1,
    });
    result = recordAttempt(result.plans, PLAN_ID, {
      sequence: 2, status: "unresolved", hash: null, submittedAt: 2, amount: "4.000000",
      payer: basePlan.payer, destination: basePlan.destination, attemptNo: 2,
    });
    // Attempt #1's evidence survives the retry — the dispatcher reads the
    // newest via latestAttemptFor, storage keeps both.
    expect(Object.keys(result.plans[0].attempts)).toEqual([
      INSTALLMENT_KEY,
      attemptKey(PLAN_ID, 2, 2),
    ]);
    expect(result.plans[0].attempts[INSTALLMENT_KEY].status).toBe("awaiting_signature");
    expect(result.plans[0].attempts[attemptKey(PLAN_ID, 2, 2)].status).toBe("unresolved");
    expect(readStored().plans[0].attempts[attemptKey(PLAN_ID, 2, 2)].submittedAt).toBe(2);
  });

  it("replaces the record when the SAME attempt number re-persists (a state transition, not a retry)", () => {
    let result = recordAttempt([basePlan], PLAN_ID, {
      sequence: 2, status: "awaiting_signature", hash: null, submittedAt: 1, amount: "4.000000", attemptNo: 1,
    });
    result = recordAttempt(result.plans, PLAN_ID, {
      sequence: 2, status: "submitted", hash: "HASH", submittedAt: 2, amount: "4.000000", attemptNo: 1,
    });
    expect(Object.keys(result.plans[0].attempts)).toEqual([INSTALLMENT_KEY]);
    expect(result.plans[0].attempts[INSTALLMENT_KEY].status).toBe("submitted");
    expect(readStored().plans[0].attempts[INSTALLMENT_KEY].hash).toBe("HASH");
  });

  it("returns persisted: false when the plan is unknown", () => {
    const plans = [basePlan];
    const result = recordAttempt(plans, "person-unknown", { sequence: 2, status: "submitted" });
    expect(result.plans).toBe(plans);
    expect(result.persisted).toBe(false);
  });

  it("returns persisted: false when the attempt has no valid sequence", () => {
    const plans = [basePlan];
    expect(recordAttempt(plans, PLAN_ID, { sequence: "due" }).persisted).toBe(false);
    expect(recordAttempt(plans, PLAN_ID, null).persisted).toBe(false);
  });

  it("reports persisted: false when the storage write fails, instead of pretending success (audit violation 3)", () => {
    const writeError = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => { throw new DOMException("quota exceeded", "QuotaExceededError"); });
    try {
      const result = recordAttempt([basePlan], PLAN_ID, { sequence: 2, status: "submitted", hash: "HASH" });
      expect(result.persisted).toBe(false);
      // The in-memory state still advanced — the caller decides what a lost
      // write means; the storage layer must not swallow the signal.
      expect(result.plans[0].attempts[INSTALLMENT_KEY].hash).toBe("HASH");
    } finally {
      writeError.mockRestore();
    }
  });

  it("records a hash-less failure (rejected signing) without advancing anything", () => {
    // The storage layer records exactly what it is told; whether paidCount
    // advances is the state machine's decision (the dispatcher's).
    const result = recordAttempt([basePlan], PLAN_ID, {
      sequence: 3,
      status: "validated_failure",
      hash: null,
      submittedAt: 5,
      amount: "4.000000",
    });
    expect(result.plans[0].attempts[attemptKey(PLAN_ID, 3, 1)]).toEqual({
      sequence: 3,
      status: "validated_failure",
      hash: null,
      submittedAt: 5,
      amount: "4.000000",
      payer: "",
      destination: "",
      attemptNo: 1,
    });
    expect(result.plans[0].paidCount).toBe(2); // untouched by storage
  });
});

describe("latestAttemptFor", () => {
  it("returns the newest attempt for the installment, across numbered retries", () => {
    const plan = {
      ...basePlan,
      attempts: {
        [attemptKey(PLAN_ID, 2, 1)]: { sequence: 2, status: "validated_failure", hash: null, submittedAt: 1, amount: "4.000000", payer: "", destination: "", attemptNo: 1 },
        [attemptKey(PLAN_ID, 2, 3)]: { sequence: 2, status: "submitted", hash: "H3", submittedAt: 3, amount: "4.000000", payer: "", destination: "", attemptNo: 3 },
        [attemptKey(PLAN_ID, 2, 2)]: { sequence: 2, status: "unresolved", hash: null, submittedAt: 2, amount: "4.000000", payer: "", destination: "", attemptNo: 2 },
        [attemptKey(PLAN_ID, 5, 1)]: { sequence: 5, status: "awaiting_signature", hash: null, submittedAt: 4, amount: "1.000000", payer: "", destination: "", attemptNo: 1 },
      },
    };
    expect(latestAttemptFor(plan, 2).attemptNo).toBe(3);
    expect(latestAttemptFor(plan, 2).hash).toBe("H3");
    expect(latestAttemptFor(plan, 5).attemptNo).toBe(1);
  });

  it("returns null when the installment has no attempts at all", () => {
    expect(latestAttemptFor(basePlan, 2)).toBeNull();
    expect(latestAttemptFor(null, 2)).toBeNull();
  });
});

describe("applyAttempt (pure core)", () => {
  it("returns a new array without touching storage", () => {
    const next = applyAttempt([basePlan], PLAN_ID, { sequence: 1, status: "awaiting_signature", hash: null });
    expect(Object.keys(next[0].attempts)).toEqual([attemptKey(PLAN_ID, 1, 1)]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("returns the same reference when nothing changed", () => {
    const plans = [basePlan];
    expect(applyAttempt(plans, "person-unknown", { sequence: 1, status: "awaiting_signature" })).toBe(plans);
    expect(applyAttempt(plans, PLAN_ID, { sequence: "due" })).toBe(plans);
  });

  it("preserves sibling plans and their attempts", () => {
    const other = { ...basePlan, id: "person-other", attempts: { [attemptKey("person-other", 7, 1)]: { sequence: 7, status: "unresolved", hash: "H", submittedAt: 9, amount: "1.000000", payer: "", destination: "", attemptNo: 1 } } };
    const next = applyAttempt([basePlan, other], "person-other", { sequence: 8, status: "submitted", hash: "H2", submittedAt: 10, amount: "1.000000" });
    expect(next[1].attempts[attemptKey("person-other", 7, 1)]).toEqual({ sequence: 7, status: "unresolved", hash: "H", submittedAt: 9, amount: "1.000000", payer: "", destination: "", attemptNo: 1 });
    expect(next[1].attempts[attemptKey("person-other", 8, 1)].hash).toBe("H2");
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
    const result = recordAttempt([{ ...basePlan, paidCount: 2 }], PLAN_ID, {
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
    expect(loadPlans()).toEqual(result.plans);
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
    const result = recordAttempt([basePlan], PLAN_ID, pollutedAttempt);
    flushPlans();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = result.plans[0].attempts[INSTALLMENT_KEY];
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
    expect(Object.keys(stored)).toEqual(PERSISTED_PLAN_KEYS);
  });

  it("persists amounts as strings only — hostile amounts never land as JSON numbers, and the attempt survives", () => {
    // attemptStore refused these with /exact decimal string/; here the
    // display-only amount is coerced to a string and the durability-critical
    // attempt record is never dropped. A float must never reach storage as a
    // number — that is the invariant behind the decimal-string rule.
    const hostile = [12.5, "12,50", "1e3", "-1", ".5", "12.5.0", null, undefined];
    let result = { plans: [basePlan] };
    hostile.forEach((amount, i) => {
      result = recordAttempt(result.plans, PLAN_ID, {
        sequence: i,
        status: "submitted",
        hash: "HASH",
        submittedAt: i,
        amount,
      });
      expect(result.plans[0].attempts[attemptKey(PLAN_ID, i, 1)]).toBeDefined();
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
    expect(canonical.plans[0].attempts[attemptKey(PLAN_ID, 9, 1)].amount).toBe("12.5000");
  });
});
