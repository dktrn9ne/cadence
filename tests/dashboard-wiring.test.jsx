// Wiring tests: the durable dispatch gate, pre-dispatch journal writes, the
// one-active-attempt guard across dispatch paths, and payer-pin enforcement —
// exercised through the real dashboard UI. Fixtures and mocks only — never a
// live seed, mnemonic, or mainnet transaction. The fixture wallet below is
// generated fresh from deterministic entropy and holds no funds.
//
// Two durable stores are in play (post PR-04 promotion):
//   - cadence-plans-v1   (planState): plans + per-installment attempt maps
//   - cadence.payments.v1 (paymentsStore): display history + append-only journal
// Plans are seeded through the planState envelope; journal/history through the
// real record save path (whitelist + checksum + secret assertion).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { SCHEMA_VERSION, STORE_KEY, save } from "../src/storage/paymentsStore.js";
import { RLUSD_ISSUER } from "../src/domain/xrpl-constants.js";

// Controllable submitter: each test installs its own behavior and counts calls.
const submitControl = { impl: null, calls: 0, resolve: null };
vi.mock("../src/services/payments.js", () => ({
  submitRlusdPayment: (...args) => { submitControl.calls += 1; return submitControl.impl(...args); },
  submitXrplConnectRlusdPayment: (...args) => { submitControl.calls += 1; return submitControl.impl(...args); },
}));

// Ledger reads (income proof, balance) use a raw WebSocket. Stub it to answer
// a funded RLUSD line immediately — hermetic and offline; the reconciliation
// path is exercised through the dispatcher's injected lookup in unit tests.
class FakeLedgerSocket {
  onmessage = null;
  close() {}
  addEventListener(type, listener) {
    if (type !== "message") return;
    this.onmessage = listener;
  }
  send() {
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          status: "success",
          result: { lines: [{ currency: "RLUSD", account: RLUSD_ISSUER, balance: "1000" }] },
        }),
      }),
    );
  }
}
vi.stubGlobal("WebSocket", FakeLedgerSocket);

// Keep xrpl's real exports except the network surface. Wallet derivation is
// faked: @noble's dual-package resolution breaks ed25519 derivation under
// vitest (verified with a minimal probe), and key derivation is upstream
// behavior this PR does not touch — the wiring under test is the journal and
// dispatch gate, which never need real key material.
const FIXTURE_ADDRESS = "rFixturePayerWalletAccount00000000000000";
const FIXTURE_SEED = "sFixtureSeedForWiringTestsOnlyNotReal00000";
vi.mock("xrpl", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeClient {
    async connect() {}
    async disconnect() {}
    async autofill(tx) { return tx; }
    async submitAndWait() { throw new Error("network disabled in tests"); }
    async request() { return { result: { meta: { TransactionResult: "tecUNKNOWN" } } }; }
  }
  class FakeWallet {
    constructor() {
      this.address = FIXTURE_ADDRESS;
      this.seed = FIXTURE_SEED;
    }
    static fromSeed() { return new FakeWallet(); }
    static fromMnemonic() { return new FakeWallet(); }
  }
  return { ...actual, Client: FakeClient, Wallet: FakeWallet };
});

import CadenceDashboard from "../src/CadenceDashboard.jsx";

// Fixture wallet: fake derivation output above — a valid-format-shaped
// throwaway. No live seed, mnemonic, or funded account is ever used.
const fixtureWallet = { address: FIXTURE_ADDRESS, seed: FIXTURE_SEED };
const DESTINATION = "rFixtureDestinationAccount0000000000000";
const PLAN_KEY = "cadence-plans-v1";

const deferredSubmitter = () => {
  submitControl.calls = 0;
  submitControl.impl = () => new Promise((resolve) => { submitControl.resolve = resolve; });
};
const tesSuccess = (hash) => ({
  result: { hash, meta: { TransactionResult: "tesSUCCESS" } },
  hash,
});
const readDoc = () => JSON.parse(window.localStorage.getItem(STORE_KEY));
const readPlans = () => JSON.parse(window.localStorage.getItem(PLAN_KEY) || "{}").plans || [];
const journalTypes = (doc) => doc.journal.map((entry) => `${entry.type}:${entry.status}`);

const planFixture = (overrides = {}) => ({
  id: "person-fixture-1",
  name: "Fixture Person",
  role: "",
  email: "",
  destination: DESTINATION,
  payMode: "weekly",
  weeklyPay: "16",
  hourlyPay: "0",
  hoursPerWeek: "0",
  frequency: "minute",
  active: false,
  paidCount: 0,
  nextRunAt: null,
  attempts: {},
  ...overrides,
});

// Seeds plans through the planState envelope (legacy form: the hardened
// loader accepts payloads written before the checksum existed).
const seedPlans = (plans) => {
  window.localStorage.setItem(
    PLAN_KEY,
    JSON.stringify({ version: 1, savedAt: Date.now(), plans }),
  );
};

// Pre-seed a valid durable record document through the real save path, and
// plans through the planState envelope.
const seedDoc = async ({ plans = [], journal = [], history = [] } = {}) => {
  if (plans.length > 0) seedPlans(plans);
  await save({ schemaVersion: SCHEMA_VERSION, history, journal });
};

// Full setup: desktop import flow (pure local crypto) → dashboard. Wallet only,
// no person created — used by tests that pre-seed a stored plan.
const setupWallet = async () => {
  window.history.pushState({}, "", "/?desktop=1");
  render(<CadenceDashboard />);

  const form = document.querySelector(".intro-connect-form");
  fireEvent.change(form.querySelector("select"), { target: { value: "family" } });
  fireEvent.change(form.querySelector('input[type="password"]'), { target: { value: fixtureWallet.seed } });
  fireEvent.submit(form);
  // The dashboard is up when the people list is visible (works with or
  // without pre-seeded plans — the empty state's "Create payment plan" is
  // absent when a stored plan hydrated).
  await waitFor(() => expect(screen.getByText(/your people/i)).toBeDefined());
};

// An active plan with no schedule window never auto-fires (the scheduler tick
// needs a due nextRunAt), so manual dispatch is the only path — exactly the
// scenario under test. The upstream dispatcher refuses dispatch for paused
// plans even manually, so scenarios drive a seeded active plan rather than a
// freshly created (inactive) editor plan.
const seedActivePlan = (overrides = {}) => {
  seedPlans([planFixture({ active: true, nextRunAt: null, payer: fixtureWallet.address, ...overrides })]);
};

// Wallet setup plus one fixture person created through the real editor.
const setupDesktopDashboard = async () => {
  await setupWallet();
  fireEvent.click(screen.getByRole("button", { name: /create payment plan/i }));
  const editor = document.querySelector(".editor-card");
  fireEvent.change(editor.querySelector('input[placeholder="Alex Morgan"]'), { target: { value: "Fixture Person" } });
  fireEvent.change(editor.querySelector('input[placeholder="r..."]'), { target: { value: DESTINATION } });
  fireEvent.submit(editor);
  await waitFor(() => expect(screen.getByRole("button", { name: /pay one installment/i })).toBeDefined());
  // planState persists on a debounced write — wait for the envelope to land
  // before any assertion reads it back.
  await waitFor(() => expect(readPlans()).toHaveLength(1));
};

const selectStoredPerson = async () => {
  // Hydration and the row's first commit are async in tests — wait for the
  // row instead of querying once (the failure would otherwise race renders).
  const row = await waitFor(() => {
    const el = document.querySelector(".person-row");
    expect(el).not.toBeNull();
    return el;
  });
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByRole("button", { name: /pay one installment/i })).toBeDefined());
};

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
  submitControl.impl = null;
  submitControl.calls = 0;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("dashboard payment journal wiring", () => {
  it("journals attempt_started before the submit resolves, then labels tesSUCCESS as validated_success", async () => {
    deferredSubmitter();
    seedActivePlan();
    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(submitControl.calls).toBe(1));

    // The attempt row is durably persisted while the submit is still in flight.
    const inFlight = readDoc();
    expect(journalTypes(inFlight)).toEqual(["attempt_started:submitted"]);
    expect(inFlight.journal[0]).toMatchObject({
      installmentId: `${readPlans()[0].id}:0`,
      planId: readPlans()[0].id,
      sequence: 0,
      attemptNo: 1,
      payerAddress: fixtureWallet.address,
      destination: DESTINATION,
    });

    submitControl.resolve(tesSuccess("HASH1"));
    await waitFor(() => expect(readDoc().journal).toHaveLength(2));
    expect(journalTypes(readDoc())).toEqual([
      "attempt_started:submitted",
      "attempt_outcome:validated_success",
    ]);
    expect(readDoc().journal[1]).toMatchObject({ txHash: "HASH1", ledgerResult: "tesSUCCESS" });
    // Locked decision: paidCount still advances on submit resolution (the
    // planState write is debounced — wait for it to land).
    await waitFor(() => expect(readPlans()[0].paidCount).toBe(1));
  });

  it("labels a ledger tec failure as validated_failure", async () => {
    submitControl.calls = 0;
    submitControl.impl = async () => ({
      result: { hash: "HASH2", meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } },
      hash: "HASH2",
    });
    seedActivePlan();
    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(journalTypes(readDoc())).toContain("attempt_outcome:validated_failure"));
    expect(readDoc().journal[1]).toMatchObject({ txHash: "HASH2", ledgerResult: "tecUNFUNDED_PAYMENT" });
  });

  it("labels a hash without a readable ledger result as unresolved", async () => {
    submitControl.calls = 0;
    submitControl.impl = async () => ({ result: { hash: "HASH3" }, hash: "HASH3" });
    seedActivePlan();
    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(journalTypes(readDoc())).toContain("attempt_outcome:unresolved"));
    expect(readDoc().journal[1]).toMatchObject({ txHash: "HASH3" });
    expect(readDoc().journal[1].ledgerResult).toBeUndefined();
  });

  it("labels a thrown submit as failed_no_hash and does not advance the count", async () => {
    submitControl.calls = 0;
    submitControl.impl = async () => { throw new Error("Wallet confirmation was cancelled."); };
    seedActivePlan();
    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(journalTypes(readDoc())).toContain("attempt_outcome:failed_no_hash"));
    expect(readDoc().journal[1].txHash).toBeUndefined();
    expect(readDoc().journal[1].error).toBe("Wallet confirmation was cancelled.");
    expect(readPlans()[0].paidCount).toBe(0);
  });

  it("refuses a second manual dispatch while an attempt is in flight", async () => {
    deferredSubmitter();
    seedActivePlan();
    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(submitControl.calls).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    // The refusal surfaces in more than one element (banner + history row).
    await waitFor(() => expect(screen.getAllByText(/in flight/i).length).toBeGreaterThan(0));
    expect(submitControl.calls).toBe(1);
    expect(readDoc().journal.filter((entry) => entry.type === "attempt_started")).toHaveLength(1);

    submitControl.resolve(tesSuccess("HASH4"));
    await waitFor(() => expect(readDoc().journal).toHaveLength(2));
  });

  it("refuses the plan-start timer path while an attempt is active, and never auto-retries it", async () => {
    // Stored in-flight attempt from a previous session — durable in BOTH
    // stores, exactly as a crash leaves them: the attempt map holds the
    // dispatch lock, the journal carries the record. Recovery relabels the
    // journal side unresolved (keeping the lock) and never auto-retries.
    seedPlans([
      planFixture({
        id: "person-fixture-1",
        active: false,
        nextRunAt: null,
        attempts: {
          "person-fixture-1:0": { sequence: 0, status: "submitted" },
        },
      }),
    ]);
    await seedDoc({
      journal: [{
        seq: 1,
        at: new Date(Date.now() - 1000).toISOString(),
        type: "attempt_started",
        status: "submitted",
        installmentId: "person-fixture-1:0",
        planId: "person-fixture-1",
        sequence: 0,
        attemptNo: 1,
      }],
    });
    submitControl.calls = 0;
    submitControl.impl = async () => tesSuccess("HASH5");

    await setupWallet();
    await selectStoredPerson();

    // "Start plan" schedules the 150ms first-payment timer.
    fireEvent.click(screen.getByRole("button", { name: /start plan/i }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The unresolved attempt holds the lock: the timer's dispatch is refused.
    expect(submitControl.calls).toBe(0);
    // Recovery is durably recorded exactly once (append-only).
    expect(readDoc().journal.filter((entry) => entry.status === "unresolved")).toHaveLength(1);
  });

  it("pins the payer on plans saved through the editor", async () => {
    await setupDesktopDashboard();
    // The editor pins under "payer"; the spec's durable field is "payerAddress" —
    // the store and guard accept either, so assert the pin exists under one.
    const plan = readPlans()[0];
    const pin = plan.payerAddress ?? plan.payer;
    expect(pin).toBe(fixtureWallet.address);
  });

  it("refuses dispatch for a plan pinned to a different payer and pauses it", async () => {
    seedPlans([
      planFixture({ payer: "rDifferentPayerWallet00000000000000000", active: true, nextRunAt: Date.now() }),
    ]);
    await seedDoc({});
    submitControl.calls = 0;
    submitControl.impl = async () => tesSuccess("HASH6");

    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(readDoc().journal.some((entry) => entry.type === "dispatch_refused")).toBe(true));
    expect(submitControl.calls).toBe(0);
    const refused = readDoc().journal.find((entry) => entry.type === "dispatch_refused");
    expect(refused.reason).toBe("payer_mismatch");
    // The mismatched plan is paused (the planState write is debounced).
    await waitFor(() => expect(readPlans()[0].active).toBe(false));
  });

  it("dispatches unchanged for a legacy plan with no pinned payer", async () => {
    // Active plan, no payer key — the pre-pin legacy shape. nextRunAt: null
    // keeps the scheduler tick out of the scenario; manual pay is the path.
    seedPlans([planFixture({ active: true, nextRunAt: null })]);
    await seedDoc({});
    submitControl.calls = 0;
    submitControl.impl = async () => tesSuccess("HASH7");

    await setupWallet();
    await selectStoredPerson();

    fireEvent.click(screen.getByRole("button", { name: /pay one installment/i }));
    await waitFor(() => expect(submitControl.calls).toBe(1));
    await waitFor(() => expect(journalTypes(readDoc())).toContain("attempt_outcome:validated_success"));
    const plan = readPlans()[0];
    // planState normalizes an absent payer to "" on persist — the legacy
    // contract is "no pin", so any falsy value means unchanged behavior.
    expect(plan.payerAddress ?? plan.payer).toBeFalsy();
  });
});
