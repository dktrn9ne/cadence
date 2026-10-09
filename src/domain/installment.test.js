import { describe, expect, it } from "vitest";

import {
  beginInstallment,
  dispatchBlockReason,
  installmentId,
  markSubmitted,
  markUnresolved,
  settleRejected,
  settleValidated,
} from "./installment.js";

// The transition matrix for the PR 04 installment state machine. Pins the two
// safety rules from the spec: only tesSUCCESS advances the plan, and an
// unresolved attempt blocks until a hash-based ledger lookup classifies it.

const PLAN_ID = "person-1760000000000";
const SEQUENCE = 2;
const NOW = 1760000001234;
const HASH =
  "9A4C7B2E5D1F80A3C6B9E2D4F7018C3A5B6E9D2C4F7A1B3E6D8C0F2A4B7E9D1C";
const TES_SUCCESS = { TransactionResult: "tesSUCCESS" };

// A plan polluted with fields that must never reach an attempt record.
function pollutedPlan() {
  return {
    id: PLAN_ID,
    paidCount: 2,
    seed: "sEdSecretSeedNeverPersisted",
    mnemonic: "lambda fox hurry...",
    privateKey: "00DEADBEEF",
  };
}

function beginAttempt() {
  return beginInstallment(pollutedPlan(), SEQUENCE, NOW);
}

function submittedAttempt() {
  return markSubmitted(beginAttempt(), HASH, NOW + 1);
}

// Caller contract from the spec's guarded dispatcher: paidCount advances once
// when an attempt first gains validated_success - never on any other status.
function advanceOnce(plan, before, settled) {
  if (settled.status === "validated_success" && before.status !== "validated_success") {
    return { ...plan, paidCount: plan.paidCount + 1 };
  }
  return plan;
}

describe("installmentId", () => {
  it("joins the plan id, a colon, and the sequence", () => {
    expect(installmentId(PLAN_ID, SEQUENCE)).toBe("person-1760000000000:2");
  });

  it("is deterministic across reloads", () => {
    expect(installmentId(PLAN_ID, SEQUENCE)).toBe(installmentId(PLAN_ID, SEQUENCE));
  });

  it("distinguishes plans and sequences", () => {
    expect(installmentId(PLAN_ID, 3)).not.toBe(installmentId(PLAN_ID, SEQUENCE));
    expect(installmentId("person-other", SEQUENCE)).not.toBe(installmentId(PLAN_ID, SEQUENCE));
  });

  it("keeps sequence 0 distinct from unset sequences", () => {
    expect(installmentId(PLAN_ID, 0)).toBe(`${PLAN_ID}:0`);
  });
});

describe("beginInstallment", () => {
  it("opens an awaiting_signature attempt with no hash", () => {
    expect(beginAttempt()).toEqual({
      sequence: SEQUENCE,
      status: "awaiting_signature",
      hash: null,
      submittedAt: NOW,
    });
  });

  it("carries only the public attempt fields, never plan extras or secrets", () => {
    expect(Object.keys(beginAttempt()).sort()).toEqual([
      "hash",
      "sequence",
      "status",
      "submittedAt",
    ]);
  });

  it("does not mutate the plan", () => {
    const plan = pollutedPlan();
    const snapshot = { ...plan };
    beginInstallment(plan, SEQUENCE, NOW);
    expect(plan).toEqual(snapshot);
  });
});

describe("markSubmitted", () => {
  it("moves awaiting_signature to submitted and captures the hash", () => {
    const attempt = beginAttempt();
    const submitted = markSubmitted(attempt, HASH, NOW + 1);
    expect(submitted.status).toBe("submitted");
    expect(submitted.hash).toBe(HASH);
    expect(submitted.submittedAt).toBe(NOW + 1);
    expect(attempt.status).toBe("awaiting_signature"); // input untouched
  });

  it("does not mutate the attempt it is given", () => {
    const frozen = Object.freeze(beginAttempt());
    expect(() => markSubmitted(frozen, HASH, NOW + 1)).not.toThrow();
  });
});

describe("settleValidated - the only advance in the system", () => {
  it("produces validated_success on tesSUCCESS meta exactly once", () => {
    const plan = { paidCount: 2 };
    const attempt = submittedAttempt();
    const settled = settleValidated(attempt, TES_SUCCESS);
    expect(settled.status).toBe("validated_success");
    const advanced = advanceOnce(plan, attempt, settled);
    expect(advanced.paidCount).toBe(3);
  });

  it("cannot double-advance: re-settling the same attempt is idempotent", () => {
    let plan = { paidCount: 2 };
    const before = submittedAttempt();
    const first = settleValidated(before, TES_SUCCESS);
    plan = advanceOnce(plan, before, first);
    const second = settleValidated(first, TES_SUCCESS);
    plan = advanceOnce(plan, first, second);
    expect(second).toEqual(first);
    expect(plan.paidCount).toBe(3); // still 3 - one advance, not two
  });

  it.each([
    "tecUNFUNDED_PAYMENT",
    "tecNO_LINE",
    "tefPAST_SEQ",
    "temBAD_AMOUNT",
  ])("records validated_failure for %s meta - never an advance", (code) => {
    const plan = { paidCount: 2 };
    const attempt = submittedAttempt();
    const settled = settleValidated(attempt, { TransactionResult: code });
    expect(settled.status).toBe("validated_failure");
    expect(settled.status).not.toBe("validated_success");
    expect(advanceOnce(plan, attempt, settled).paidCount).toBe(2);
  });

  it("treats missing meta as a failed attempt, not an advance", () => {
    for (const meta of [null, undefined]) {
      const attempt = submittedAttempt();
      const settled = settleValidated(attempt, meta);
      expect(settled.status).toBe("validated_failure");
      expect(advanceOnce({ paidCount: 2 }, attempt, settled).paidCount).toBe(2);
    }
  });

  it("preserves the transaction hash as evidence", () => {
    expect(settleValidated(submittedAttempt(), TES_SUCCESS).hash).toBe(HASH);
  });
});

describe("settleRejected", () => {
  it("records validated_failure for a ledger failure and keeps the hash", () => {
    const settled = settleRejected(submittedAttempt(), {
      TransactionResult: "tecNO_LINE",
    });
    expect(settled.status).toBe("validated_failure");
    expect(settled.hash).toBe(HASH);
    expect(settled.submittedAt).toBe(NOW + 1);
  });

  it("records a hash-less wallet rejection as a failed attempt", () => {
    const hashless = markSubmitted(beginAttempt(), null, NOW + 1);
    const settled = settleRejected(hashless, null);
    expect(settled.status).toBe("validated_failure");
    expect(settled.hash).toBeNull();
  });
});

describe("markUnresolved", () => {
  it("moves submitted to unresolved with the hash stamped for later lookup", () => {
    const attempt = markUnresolved(submittedAttempt(), HASH, NOW + 2);
    expect(attempt.status).toBe("unresolved");
    expect(attempt.hash).toBe(HASH);
    expect(attempt.submittedAt).toBe(NOW + 2);
    expect(attempt.sequence).toBe(SEQUENCE);
  });
});

describe("dispatchBlockReason - the guard the dispatcher consumes", () => {
  it("allows a fresh installment with no attempt yet", () => {
    expect(dispatchBlockReason(undefined)).toBeNull();
    expect(dispatchBlockReason(null)).toBeNull();
  });

  it("allows a fresh, user-visible retry after a terminal failure", () => {
    const failed = settleRejected(submittedAttempt(), {
      TransactionResult: "tecNO_LINE",
    });
    expect(dispatchBlockReason(failed)).toBeNull();
  });

  it("blocks while a wallet prompt or submission is in flight", () => {
    expect(dispatchBlockReason(beginAttempt())).toBe("already-in-flight");
    expect(dispatchBlockReason(submittedAttempt())).toBe("already-in-flight");
  });

  it("blocks an unresolved attempt until the ledger classifies it", () => {
    expect(dispatchBlockReason(markUnresolved(submittedAttempt(), HASH, NOW + 2))).toBe(
      "unresolved-attempt",
    );
  });

  it("blocks an already-validated installment - re-sending it is the double-pay path", () => {
    const settled = settleValidated(submittedAttempt(), TES_SUCCESS);
    expect(dispatchBlockReason(settled)).toBe("already-validated");
  });

  it("fails closed on an unrecognized attempt status", () => {
    expect(dispatchBlockReason({ status: "mystery" })).toBe("unknown-attempt-state");
  });
});

describe("transition matrix", () => {
  it("happy path: begin -> submitted -> validated_success seals the installment", () => {
    const attempt = settleValidated(submittedAttempt(), TES_SUCCESS);
    expect(attempt.status).toBe("validated_success");
    expect(dispatchBlockReason(attempt)).toBe("already-validated");
  });

  it("rejection path: a failed attempt leaves the installment dispatchable again", () => {
    const attempt = settleRejected(submittedAttempt(), {
      TransactionResult: "tecNO_LINE",
    });
    expect(attempt.status).toBe("validated_failure");
    expect(dispatchBlockReason(attempt)).toBeNull();
  });

  it("unresolved path: only a hash-based ledger classification re-enters the machine", () => {
    let attempt = markUnresolved(submittedAttempt(), HASH, NOW + 2);
    // No timer exit and no fresh submission: dispatch stays blocked...
    expect(dispatchBlockReason(attempt)).toBe("unresolved-attempt");
    // ...until the ledger lookup returns meta and the reconcile caller
    // re-enters classification through the same settle gate.
    attempt = settleValidated(attempt, TES_SUCCESS);
    expect(attempt.status).toBe("validated_success");
    expect(dispatchBlockReason(attempt)).toBe("already-validated");
  });

  it("lifecycle writes never mutate their inputs", () => {
    const frozen = Object.freeze({
      sequence: SEQUENCE,
      status: "submitted",
      hash: HASH,
      submittedAt: NOW + 1,
    });
    expect(() => settleValidated(frozen, TES_SUCCESS)).not.toThrow();
    expect(() => settleRejected(frozen, { TransactionResult: "tecNO_LINE" })).not.toThrow();
    expect(() => markUnresolved(frozen, HASH, NOW + 2)).not.toThrow();
    expect(frozen.status).toBe("submitted");
  });
});

// Ported from main's superseded paymentOutcome.test.js (PR #11, unwired):
// its legal-move matrix and expiry rule, expressed through this module's
// named-transition API. The moves main enumerated as a transition table are
// re-entered here the way the wired dispatcher does it — through
// settleValidated/settleRejected/markUnresolved — and the moves main made
// throw are guarded here by dispatchBlockReason, which fails closed.
describe("reconciliation re-entry and expiry (ported from paymentOutcome)", () => {
  it("re-enters from unresolved to validated_failure when the ledger reports a tec* result", () => {
    // Legal move unresolved -> validated_failure: the lookup finished the
    // story on the failure side. The installment becomes dispatchable again
    // as a fresh, user-visible retry.
    const unresolved = markUnresolved(submittedAttempt(), HASH, NOW + 2);
    const settled = settleRejected(unresolved, { TransactionResult: "tecNO_LINE" });
    expect(settled.status).toBe("validated_failure");
    expect(settled.hash).toBe(HASH); // evidence preserved through re-entry
    expect(dispatchBlockReason(settled)).toBeNull();
  });

  it("moves a stale awaiting_signature record to unresolved - the mid-window close", () => {
    // The expiry rule: a stale in-flight record exits through unresolved
    // (its submission may still be on-ledger), never straight to a terminal
    // verdict guessed by a timer.
    const stale = beginAttempt();
    const unresolved = markUnresolved(stale, HASH, NOW + 2);
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.hash).toBe(HASH);
    expect(dispatchBlockReason(unresolved)).toBe("unresolved-attempt");
  });

  it("a stale in-flight record is blocked and only the ledger lookup re-enters - never a fresh dispatch", () => {
    for (const stale of [beginAttempt(), submittedAttempt()]) {
      expect(dispatchBlockReason(stale)).toBe("already-in-flight");
      const unresolved = markUnresolved(stale, HASH, NOW + 2);
      expect(dispatchBlockReason(unresolved)).toBe("unresolved-attempt");
    }
  });

  it("fail closed: a persisted 'scheduled' status is not a legal attempt state and blocks dispatch", () => {
    // In this machine attempts begin at awaiting_signature; a record stored
    // as 'scheduled' is corrupt or foreign, so it must not dispatch.
    expect(dispatchBlockReason({ status: "scheduled" })).toBe("unknown-attempt-state");
  });
});
