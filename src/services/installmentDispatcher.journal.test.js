// Dispatcher journal-event tests: the guarded door reports each truth point
// to the append-only journal — attempt_started BEFORE submit, and every
// terminal outcome labeled with what the ledger actually said.
// Fixtures only — no ledger access, never a live seed.
import { describe, expect, it, vi } from "vitest";
import { createInstallmentDispatcher } from "./installmentDispatcher.js";
import { OUTCOMES } from "./xrplLedger.js";

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

describe("dispatcher journal events", () => {
  it("emits attempt_started before the submit call", async () => {
    const order = [];
    const { dispatcher } = buildDispatcher({
      order,
      submit: async () => {
        order.push("submit-called");
        return { result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH };
      },
    });
    const outcome = await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });
    expect(outcome.dispatched).toBe(true);
    expect(order).toEqual(["journal:attempt_started:", "submit-called", "journal:attempt_outcome:validated_success"]);
  });

  it("labels a tesSUCCESS outcome with the hash and ledger result", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => ({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH }),
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
      submit: async () => ({
        result: { meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } },
        hash: HASH,
      }),
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
    expect(reconcile).toHaveBeenCalledWith(HASH);
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

  it("records failed_no_hash when the submit call throws", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => {
        throw new Error("network unreachable");
      },
    });
    const outcome = await dispatcher.dispatchInstallment(planFixture(), 3, "scheduled", { amount: "2.666667" });

    expect(outcome.dispatched).toBe(true);
    const event = events.find((event) => event.type === "attempt_outcome");
    expect(event).toMatchObject({
      status: "failed_no_hash",
      installmentId: "person-1734:3",
      reason: "construction_or_network",
    });
    expect(event.error).toContain("network unreachable");
    expect(event.txHash).toBeUndefined();
  });

  it("records failed_no_hash with reason sign_rejected when no hash is returned", async () => {
    const { dispatcher, events } = buildDispatcher({
      submit: async () => ({}), // wallet cancelled — no result, no hash
    });
    await dispatcher.dispatchInstallment(planFixture(), 3, "manual", { amount: "2.666667" });

    const event = events.find((event) => event.type === "attempt_outcome");
    expect(event).toMatchObject({
      status: "failed_no_hash",
      installmentId: "person-1734:3",
      reason: "sign_rejected",
    });
  });
});
