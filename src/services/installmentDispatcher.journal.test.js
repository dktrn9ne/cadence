// Dispatcher journal-event tests: the guarded door reports each truth point
// to the append-only journal — attempt_started BEFORE submit, and every
// terminal outcome labeled with what the ledger actually said.
// Fixtures only — no ledger access, never a live seed.
import { describe, expect, it, vi } from "vitest";
import { createInstallmentDispatcher } from "./installmentDispatcher.js";
import { OUTCOMES } from "./xrplLedger.js";
import { RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG } from "../domain/xrpl-constants.js";

const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DEST = "rFixtur3DestAcct11111111111111111111";
const HASH = "A1".repeat(32); // 64 hex chars — real transaction-hash shape

const planFixture = (overrides = {}) => ({
  id: "person-1734",
  name: "Fixture Person",
  weeklyPay: "16",
  frequency: "minute",
  active: true,
  paidCount: 0,
  attempts: {},
  payer: PAYER,
  address: DEST,
  ...overrides,
});

// Builds a dispatcher over a mutable local plans array and captures journal
// events. The optional `order` array receives a label per journal event, so a
// test's own submit mock can interleave "submit-called" into the same
// timeline to prove the started-entry precedes the submit call.
function buildDispatcher({ plan = planFixture(), submit, reconcile, order = [] } = {}) {
  const plans = [plan];
  const events = [];
  const dispatcher = createInstallmentDispatcher({
    getPlans: () => plans,
    setPlans: (next) => {
      plans.length = 0;
      plans.push(...next);
    },
    submit: submit ?? vi.fn(),
    reconcile,
    onJournalEvent: (event) => {
      order.push(`journal:${event.type}:${event.status ?? ""}`);
      events.push(event);
    },
  });
  return { dispatcher, plans, events, order };
}

// A receipt that carries the transaction body — the shape local
// submitAndWait returns, where the dispatcher verifies identity directly and
// the ledger meta classifies without a lookup.
const bodyReceipt = (hash, transactionResult) => ({
  result: {
    hash,
    meta: { TransactionResult: transactionResult },
    Account: PAYER,
    Destination: DEST,
    Amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: "2.666667" },
    SourceTag: SOURCE_TAG,
  },
  hash,
});

describe("dispatcher journal events", () => {
  it("emits attempt_started before the submit call", async () => {
    const order = [];
    const { dispatcher } = buildDispatcher({
      order,
      submit: async () => {
        order.push("submit-called");
        return bodyReceipt(HASH, "tesSUCCESS");
      },
    });
    const outcome = await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });
    expect(outcome.dispatched).toBe(true);
    expect(order).toEqual(["journal:attempt_started:", "submit-called", "journal:attempt_outcome:validated_success"]);
  });

  it("labels a tesSUCCESS outcome with the hash and ledger result", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => bodyReceipt(HASH, "tesSUCCESS"),
    });
    await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    const started = events.find((event) => event.type === "attempt_started");
    const outcome = events.find((event) => event.type === "attempt_outcome");
    expect(started).toMatchObject({
      sequence: 3,
      amount: "2.666667",
      destination: DEST,
      payerAddress: PAYER,
      source: "scheduled",
    });
    expect(outcome).toMatchObject({
      status: "validated_success",
      installmentId: "person-1734:3",
      txHash: HASH,
      ledgerResult: "tesSUCCESS",
    });
  });

  it("labels a ledger tec-failure as validated_failure, never as paid", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => bodyReceipt(HASH, "tecUNFUNDED_PAYMENT"),
    });
    await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    const outcome = events.find((event) => event.type === "attempt_outcome");
    expect(outcome.status).toBe("validated_failure");
    expect(outcome.ledgerResult).toBe("tecUNFUNDED_PAYMENT");
    expect(outcome.txHash).toBe(HASH);
  });

  it("labels a hash without a readable verdict unresolved after an unknown lookup", async () => {
    const reconcile = vi.fn(async () => ({ outcome: OUTCOMES.UNKNOWN }));
    const { dispatcher, events } = buildDispatcher({
      submit: async () => ({ result: {}, hash: HASH }),
      reconcile,
    });
    await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    const outcome = events.find((event) => event.type === "attempt_outcome");
    // Main's dispatcher reconciles bodyless receipts by hash with the payment
    // identity as context, so a later manual reconciliation can double-check.
    expect(reconcile).toHaveBeenCalledWith(HASH, {
      amount: "2.666667",
      destination: DEST,
      payer: PAYER,
    });
    expect(outcome.status).toBe("unresolved");
    expect(outcome.txHash).toBe(HASH);
    expect(outcome.ledgerResult).toBeUndefined();
  });

  it("reconciles an unreadable outcome to validated_success when the ledger says tesSUCCESS", async () => {
    const reconcile = vi.fn(async () => ({ outcome: OUTCOMES.SUCCESS }));
    const { dispatcher, events } = buildDispatcher({
      submit: async () => ({ result: {}, hash: HASH }),
      reconcile,
    });
    await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    const outcome = events.find((event) => event.type === "attempt_outcome");
    expect(outcome.status).toBe("validated_success");
    expect(outcome.ledgerResult).toBe("tesSUCCESS");
  });

  it("parks an unknown submit error as unresolved — provability decides", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => {
        throw new Error("network unreachable");
      },
    });
    const outcome = await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    expect(outcome.dispatched).toBe(true);
    const event = events.find((event) => event.type === "attempt_outcome");
    // An unknown transport error proves nothing: the submission may have
    // landed, so only a ledger lookup by hash can release it — never a
    // failed_no_hash label, which would authorize an automatic retry.
    expect(event).toMatchObject({
      status: "unresolved",
      installmentId: "person-1734:3",
      reason: "network",
    });
    expect(event.error).toContain("network unreachable");
    expect(event.txHash).toBeUndefined();
  });

  it("records failed_no_hash when the wallet rejects signing", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => {
        // The real rejection shape: xrpl-connect throws a WalletError with
        // code SIGN_REJECTED — provably nothing was submitted.
        throw Object.assign(new Error("Wallet confirmation was cancelled."), { code: "SIGN_REJECTED" });
      },
    });
    const outcome = await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    expect(outcome.dispatched).toBe(true);
    const event = events.find((event) => event.type === "attempt_outcome");
    expect(event).toMatchObject({
      status: "failed_no_hash",
      installmentId: "person-1734:3",
      reason: "sign_rejected",
    });
    expect(event.error).toContain("Wallet confirmation was cancelled.");
    expect(event.txHash).toBeUndefined();
  });

  it("parks a hash-less wallet resolution as unresolved", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => ({}), // wallet resolved — no result, no hash
    });
    await dispatcher.dispatchInstallment(planFixture(), 3, "manual", { amount: "2.666667" });

    const event = events.find((event) => event.type === "attempt_outcome");
    // The wallet's resolution is not proof of either outcome, and no hash
    // exists to reconcile — the attempt stays blocked as unresolved.
    expect(event).toMatchObject({
      status: "unresolved",
      installmentId: "person-1734:3",
      reason: "no_usable_hash",
    });
  });
});
