// Focused unit suite for the canonical guarded dispatcher (audit
// art_FIvT05e6). Each `audit violation N` test first reproduces the probe
// behavior the audit recorded against main, then pins the fixed behavior.
//
// The dispatcher's collaborators are injected: app state is a plain array in
// this file, the submitter and reconciler are vi.fn()s, and persistence goes
// through the real planState module over jsdom localStorage — the fail-closed
// test breaks exactly that write. No fake timers: the dispatcher's `now` is
// injected, and every submit promise here settles within the test body.

import { describe, expect, it, vi } from "vitest";
import { createInstallmentDispatcher } from "./installmentDispatcher.js";
import { attemptKey, flushPlans, latestAttemptFor } from "../storage/planState.js";
import { RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG } from "../domain/xrpl-constants.js";

const PAYER = "rPayerAccount1111111111111111111111111111111111";
const DEST_A = "rDestinationA1111111111111111111111111111111111";
const DEST_OTHER = "rDestinationZZZZ9999999999999999999999999999999999";
const HASH = "9A4C7B2E5D8F1A3C6E9B2D4F7A1C8E3B6D9F2A5C8E1B4D7F0A3C6E9B2D5F8A1C";
const HASH_2 = "8B4C7B2E5D8F1A3C6E9B2D4F7A1C8E3B6D9F2A5C8E1B4D7F0A3C6E9B2D5F8A1C";
const NOW = 1760000000000;
const DAY_MS = 24 * 60 * 60 * 1000;

// weekly 7 / day frequency: 7 payments of 1.000000 each, so the dispatcher
// has headroom to advance several installments.
const makePlan = (overrides = {}) => ({
  id: "plan-1",
  name: "Riley",
  payMode: "weekly",
  weeklyPay: "7",
  frequency: "day",
  destination: DEST_A,
  payer: PAYER,
  active: true,
  paidCount: 0,
  nextRunAt: null,
  ...overrides,
});

const rlusdAmount = (value) => ({ currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value });

const attemptsOf = (plans, planId) =>
  plans.find((plan) => plan?.id === planId)?.attempts || {};

const attemptsList = (plans, planId) => Object.values(attemptsOf(plans, planId));

describe("guarded installment dispatcher", () => {
  const setup = ({
    plan = makePlan(),
    submit = vi.fn(),
    // Default reconcile: a classified ledger success. Injected per test for
    // mismatch/unknown answers; without an injection the bodyless-receipt
    // tests would reach the real xrpl Client and attempt a live socket.
    reconcile = vi.fn().mockResolvedValue({ outcome: "validated_success" }),
  } = {}) => {
    flushPlans();
    let plans = [plan];
    const dispatcher = createInstallmentDispatcher({
      getPlans: () => plans,
      setPlans: (next) => {
        plans = next;
      },
      submit,
      reconcile,
      now: () => NOW,
    });
    return { dispatcher, submit, reconcile, plansRef: () => plans, setPlans: (next) => { plans = next; } };
  };

  it("audit violation 1 (P3 probe): a tesSUCCESS receipt for someone else's payment never advances", async () => {
    // The probe on main: a bodyless receipt advanced paidCount; then a fixed
    // verdict-only path still classified tesSUCCESS without comparing the
    // transaction body. Here the receipt DOES carry a body — with the wrong
    // destination — and the verdict must classify nothing.
    const { dispatcher, submit, plansRef } = setup();
    submit.mockResolvedValue({
      result: {
        Account: PAYER,
        Destination: DEST_OTHER,
        Amount: rlusdAmount("1.000000"),
        SourceTag: SOURCE_TAG,
        meta: { TransactionResult: "tesSUCCESS" },
      },
      hash: HASH,
    });

    const result = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });

    expect(result.outcome).toBe("unresolved");
    expect(result.anomaly).toBe("identity_mismatch");
    const [attempt] = attemptsList(plansRef(), "plan-1");
    expect(attempt.status).toBe("unresolved");
    expect(attempt.hash).toBe(HASH);
    expect(plansRef()[0].paidCount).toBe(0);
    expect(plansRef()[0].nextRunAt).toBeNull();
  });

  it("audit violation 1: the hash lookup receives the attempt's identity for verification", async () => {
    // Bodyless adapter receipt -> the hash lookup is the only classifier. The
    // probe on main discarded the tx body entirely: the lookup never received
    // payer/destination/amount, so a wrong-recipient tesSUCCESS advanced a
    // plan. The regression pins the seam: this attempt's identity rides with
    // the lookup, and the real reconciler (tests/xrplLedger.test.js) verifies
    // the body against it before any verdict may classify.
    const reconcile = vi.fn().mockResolvedValue({ outcome: "still_unknown", anomaly: "identity_mismatch" });
    const { dispatcher, submit, plansRef } = setup({ reconcile });
    submit.mockResolvedValue({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });

    const result = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });

    expect(reconcile).toHaveBeenCalledWith(HASH, { payer: PAYER, destination: DEST_A, amount: "1.000000" });
    expect(result.outcome).toBe("unresolved");
    expect(result.anomaly).toBe("identity_mismatch");
    expect(attemptsList(plansRef(), "plan-1")[0].status).toBe("unresolved");
    expect(plansRef()[0].paidCount).toBe(0);
  });

  it("only an identity-matched validated success advances, exactly once", async () => {
    const { dispatcher, submit, plansRef } = setup();
    submit.mockResolvedValue({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });

    const result = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });

    expect(result).toMatchObject({ dispatched: true, outcome: "validated_success", nextPaidCount: 1, complete: false });
    const plan = plansRef()[0];
    expect(plan.paidCount).toBe(1);
    expect(plan.nextRunAt).toBe(NOW + DAY_MS);
    expect(plan.active).toBe(true);
    const [attempt] = attemptsList(plansRef(), "plan-1");
    expect(attempt.status).toBe("validated_success");
    expect(attempt.hash).toBe(HASH);
    expect(attempt.attemptNo).toBe(1);
  });

  it("audit violation 2 (P3 sibling probe): a hashless resolved submission parks unresolved and blocks every later dispatch", async () => {
    // The probe on main: a resolved-without-hash submission filed a
    // RETRYABLE failed attempt and the next dispatch fired again. Whether the
    // payment landed is unknowable — it must park unresolved, and the
    // durable guard must refuse the next dispatch.
    const { dispatcher, submit, plansRef } = setup();
    submit.mockResolvedValue({ result: {}, hash: null });

    const first = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });
    expect(first).toMatchObject({ dispatched: true, outcome: "unresolved", hash: null });
    expect(attemptsList(plansRef(), "plan-1")[0].status).toBe("unresolved");

    const second = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });
    expect(second).toMatchObject({ dispatched: false, reason: "unresolved-attempt" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(plansRef()[0].paidCount).toBe(0);
  });

  it("audit violation 2: a transport error after submit-start parks unresolved, never a retryable failure", async () => {
    const { dispatcher, submit, plansRef } = setup();
    submit.mockRejectedValue(new Error("websocket timeout"));

    const result = await dispatcher.dispatchInstallment(makePlan(), 0, "scheduled", { amount: "1.000000", payer: PAYER });

    expect(result).toMatchObject({ dispatched: true, outcome: "unresolved" });
    expect(attemptsList(plansRef(), "plan-1")[0].status).toBe("unresolved");
    expect(plansRef()[0].paidCount).toBe(0);
    // A scheduled send that ends without success must not leave its window
    // in the past — the tick would read that as a retry signal.
    expect(plansRef()[0].nextRunAt).toBeNull();
  });

  it("a sign rejection is the provably pre-submission failure: failed attempt, retry allowed", async () => {
    // Verified @textrp/xrpl-connect 0.6.0 WalletError shape.
    const { dispatcher, submit, plansRef } = setup();
    submit.mockRejectedValue(Object.assign(new Error("User rejected the payload"), { name: "WalletError", code: "SIGN_REJECTED" }));

    const first = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });
    expect(first).toMatchObject({ dispatched: true, outcome: "validated_failure" });
    expect(attemptsList(plansRef(), "plan-1")[0].status).toBe("validated_failure");
    expect(plansRef()[0].paidCount).toBe(0);

    // Retry-safe: the durable guard permits a fresh attempt.
    submit.mockResolvedValue({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });
    const second = await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });
    expect(second).toMatchObject({ dispatched: true, outcome: "validated_success" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("audit violation 3 (P2 probe): a failed attempt-record write blocks the payment — nothing is submitted untracked", async () => {
    // The probe on main: with storage unavailable, the dispatcher submitted
    // and advanced with ZERO durable record — an unreconcilable payment. The
    // fixed contract: the awaiting_signature record must land durably BEFORE
    // the submit call, or the payment does not go out.
    flushPlans();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      let plans = [makePlan()];
      const submit = vi.fn().mockResolvedValue({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });
      const dispatcher = createInstallmentDispatcher({
        getPlans: () => plans,
        setPlans: (next) => {
          plans = next;
        },
        submit,
        now: () => NOW,
      });

      const result = await dispatcher.dispatchInstallment(plans[0], 0, "manual", { amount: "1.000000", payer: PAYER });

      expect(result.dispatched).toBe(false);
      expect(result.reason).toBe("store-failed");
      expect(submit).not.toHaveBeenCalled();
      expect(plans[0].paidCount).toBe(0);
      // The in-memory record still exists (app state is honest about the
      // attempt that was blocked), but it never progressed past
      // awaiting_signature and nothing was submitted untracked.
      const [blockedAttempt] = attemptsList(plans, "plan-1");
      expect(blockedAttempt.status).toBe("awaiting_signature");
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("audit violation 4: each retry writes its own numbered record and never overwrites the attempt before it", async () => {
    // The probe on main: retries overwrote the single attempt slot, erasing
    // the evidence of the first attempt. Numbered keys keep every record.
    const { dispatcher, submit, plansRef } = setup();
    submit.mockRejectedValueOnce(Object.assign(new Error("User rejected the payload"), { name: "WalletError", code: "SIGN_REJECTED" }));
    await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });

    submit.mockResolvedValue({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH_2 });
    await dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });

    const attempts = attemptsOf(plansRef(), "plan-1");
    expect(Object.keys(attempts)).toEqual([
      attemptKey("plan-1", 0, 1),
      attemptKey("plan-1", 0, 2),
    ]);
    expect(attempts[attemptKey("plan-1", 0, 1)].status).toBe("validated_failure");
    expect(attempts[attemptKey("plan-1", 0, 1)].hash).toBeNull();
    expect(attempts[attemptKey("plan-1", 0, 2)].status).toBe("validated_success");
    expect(attempts[attemptKey("plan-1", 0, 2)].attemptNo).toBe(2);
    // The dispatch guard reads the NEWEST attempt; the old one is history.
    expect(latestAttemptFor(plansRef()[0], 0).attemptNo).toBe(2);
    expect(plansRef()[0].paidCount).toBe(1);
  });

  it("the in-flight claim refuses a second dispatch for the same installment", async () => {
    // Real overlap: dispatch #2 is invoked while dispatch #1's submit is
    // still pending — manual click racing a scheduler tick.
    let resolveSubmit;
    const { dispatcher, submit } = setup();
    submit.mockImplementation(() => new Promise((resolve) => { resolveSubmit = resolve; }));

    const first = dispatcher.dispatchInstallment(makePlan(), 0, "manual", { amount: "1.000000", payer: PAYER });
    const second = await dispatcher.dispatchInstallment(makePlan(), 0, "scheduled", { amount: "1.000000", payer: PAYER });
    expect(second).toMatchObject({ dispatched: false, reason: "already-in-flight" });

    resolveSubmit({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });
    await first;
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a paused plan refuses dispatch without submitting", async () => {
    const { dispatcher, submit, plansRef } = setup({ plan: makePlan({ active: false }) });

    const result = await dispatcher.dispatchInstallment(makePlan({ active: false }), 0, "scheduled", { amount: "1.000000", payer: PAYER });

    expect(result).toMatchObject({ dispatched: false, reason: "plan-paused" });
    expect(submit).not.toHaveBeenCalled();
    expect(attemptsList(plansRef(), "plan-1")).toEqual([]);
  });

  it("a complete plan deactivates instead of dispatching past its budget", async () => {
    const { dispatcher, submit, plansRef } = setup({ plan: makePlan({ paidCount: 7 }) });

    const result = await dispatcher.dispatchInstallment(makePlan({ paidCount: 7 }), 0, "scheduled", { amount: "1.000000", payer: PAYER });

    expect(result).toMatchObject({ dispatched: false, reason: "plan-complete" });
    expect(submit).not.toHaveBeenCalled();
    expect(plansRef()[0].active).toBe(false);
    expect(plansRef()[0].nextRunAt).toBeNull();
  });

  it("a validated success on the last installment completes the plan", async () => {
    const { dispatcher, submit, plansRef } = setup({ plan: makePlan({ paidCount: 6 }) });
    submit.mockResolvedValue({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });

    const result = await dispatcher.dispatchInstallment(makePlan({ paidCount: 6 }), 0, "manual", { amount: "1.000000", payer: PAYER });

    expect(result).toMatchObject({ dispatched: true, outcome: "validated_success", nextPaidCount: 7, complete: true });
    const plan = plansRef()[0];
    expect(plan.active).toBe(false);
    expect(plan.nextRunAt).toBeNull();
    expect(plan.paidCount).toBe(7);
  });
});
