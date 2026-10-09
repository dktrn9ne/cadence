// Dashboard-level tests for mount recovery and missed-window approval (PR 04
// wave 4). These pin the spec's verification rows:
//
//   - "Reload restores plans, never bursts" — seeded plans with paidCount 2
//     and an in-past nextRunAt remount with ZERO submit calls, the restored
//     card shows 2 / total, and the missed window waits for an explicit
//     approval; approving dispatches exactly ONE installment.
//   - "Unresolved blocks until reconciled by hash" — an unresolved attempt
//     disables the pay button; a reconcile returning tesSUCCESS unblocks and
//     advances exactly once; still_unknown keeps the block.
//
// Hermetic by construction: the wallet manager, payment submitters, and the
// xrpl client are all mocked; nothing here touches the network, signs a real
// transaction, or loads secret material. Seeds use the exact persisted
// envelope shape the storage module writes.
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CadenceDashboard from "./CadenceDashboard.jsx";
import { submitXrplConnectRlusdPayment } from "./services/payments.js";
import { flushPlans } from "./storage/planState.js";
import { RLUSD_ISSUER } from "./domain/xrpl-constants.js";

vi.mock("./services/payments.js", () => ({
  submitRlusdPayment: vi.fn(),
  submitXrplConnectRlusdPayment: vi.fn(),
}));

vi.mock("xrpl", () => {
  const clientRequest = vi.fn();
  class FakeClient {
    async connect() {}
    async disconnect() {}
    request(request) {
      return clientRequest(request);
    }
  }
  return {
    Client: FakeClient,
    ECDSA: {},
    Wallet: { fromSeed: vi.fn(), fromMnemonic: vi.fn() },
    __clientRequest: clientRequest,
  };
});

vi.mock("@textrp/xrpl-connect", () => {
  class FakeAdapter {}
  class FakeWalletManager {
    connected = true;
    account = { address: PAYER_ADDRESS };
    wallet = { id: "xaman" };
    on() {}
    off() {}
    open() {}
    async close() {}
  }
  return {
    WalletManager: FakeWalletManager,
    XamanAdapter: FakeAdapter,
    CrossmarkAdapter: FakeAdapter,
    GemWalletAdapter: FakeAdapter,
    XyraAdapter: FakeAdapter,
  };
});

import { __clientRequest } from "xrpl";

const PAYER_ADDRESS = "rPayerAccount1111111111111111111111111111111111";
const DEST_A = "rDestinationA1111111111111111111111111111111111";
const HASH = "9A4C7B2E5D8F1A3C6E9B2D4F7A1C8E3B6D9F2A5C8E1B4D7F0A3C6E9B2D5F8A1C";
const STORAGE_KEY = "cadence-plans-v1";
const DAY_MS = 24 * 60 * 60 * 1000;

class FakeWebSocket {
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

const flushUI = async (rounds = 10) => {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
};

const tickScheduler = async () => {
  await act(async () => {
    vi.advanceTimersByTime(10000);
    await Promise.resolve();
  });
};

const meterCount = () =>
  screen.getByText("Installments sent").parentElement.querySelector("strong").textContent;

const storedPlans = () =>
  JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}").plans || [];

const seedPlans = (plans) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), plans }));
};

const tesSUCCESS = { result: { validated: true, meta: { TransactionResult: "tesSUCCESS" } } };

// A stored plan exactly as the storage allowlist writes it: destination
// (not address), string schedule fields, attempt ledger keyed by the
// deterministic installment id. frequency "day" with weeklyPay "7" gives a
// 7-installment schedule at 1 RLUSD each.
const makeSeedPlan = (overrides = {}) => ({
  id: "person-1760000000000",
  payer: PAYER_ADDRESS,
  destination: DEST_A,
  paidCount: 2,
  nextRunAt: null,
  active: true,
  name: "Riley",
  role: "Designer",
  email: "riley@example.com",
  payMode: "weekly",
  weeklyPay: "7",
  hourlyPay: "0",
  hoursPerWeek: "0",
  frequency: "day",
  attempts: {},
  ...overrides,
});

// Mount with an optional StrictMode wrapper (recovery must survive React
// 19's double-mounted effects in dev), then connect the mocked wallet to
// reach the employer dashboard.
async function mountAndConnect(ui = <CadenceDashboard />) {
  render(ui);
  await flushUI();
  fireEvent.click(screen.getByRole("button", { name: /Connect XRPL wallet/i }));
  await flushUI();
  // "Payment plans" renders twice with at least one plan (section heading +
  // stats-bar label), unlike the zero-plan state the dispatch tests see.
  expect(screen.getAllByText("Payment plans").length).toBeGreaterThan(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  window.WebSocket = FakeWebSocket;
  vi.clearAllMocks();
  __clientRequest.mockReset();
});

afterEach(() => {
  cleanup();
  flushPlans();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("mount recovery: reload restores plans, never bursts", () => {
  it("restores a paidCount 2 plan with an in-past nextRunAt: zero submits, missed window waits for approval", async () => {
    const now = Date.now();
    seedPlans([makeSeedPlan({ nextRunAt: now - DAY_MS + 60000 })]); // exactly 1 missed window
    await mountAndConnect();

    // Recovery restored the meter and dispatched nothing.
    expect(meterCount()).toBe("2 / 7");
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();

    // The scheduler tick refuses the catch-up plan too — no auto-fire, ever.
    await tickScheduler();
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();

    // The missed window is surfaced for an explicit approval...
    expect(screen.getByText(/1 installment missed while the app was closed/i)).toBeTruthy();
    expect(screen.getByText(/Approve to send installment #3/i)).toBeTruthy();

    // ...and approving dispatches exactly ONE installment through the
    // guarded door, advancing the meter exactly once.
    submitXrplConnectRlusdPayment.mockResolvedValue({
      result: { meta: { TransactionResult: "tesSUCCESS" } },
      hash: HASH,
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve send" }));
    await flushUI(6);
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);
    expect(meterCount()).toBe("3 / 7");

    // The prompt is spent: no second approval for the same window.
    expect(screen.queryByRole("button", { name: "Approve send" })).toBeNull();
  });

  it("approval of a second missed window sends exactly one more installment (no burst)", async () => {
    const now = Date.now();
    seedPlans([makeSeedPlan({ nextRunAt: now - 2 * DAY_MS + 60000 })]); // 2 missed windows
    submitXrplConnectRlusdPayment.mockResolvedValue({
      result: { meta: { TransactionResult: "tesSUCCESS" } },
      hash: HASH,
    });
    await mountAndConnect();
    expect(screen.getByText(/2 installments missed while the app was closed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve send" }));
    await flushUI(6);
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);
    expect(meterCount()).toBe("3 / 7");

    // One approval = one window: the prompt re-arms for the next one only.
    expect(screen.getByText(/1 installment missed while the app was closed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve send" }));
    await flushUI(6);
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(2);
    expect(meterCount()).toBe("4 / 7");
    expect(screen.queryByRole("button", { name: "Approve send" })).toBeNull();
  });

  it("skipping the missed window submits nothing and slides the schedule past the abandoned window", async () => {
    const now = Date.now();
    seedPlans([makeSeedPlan({ nextRunAt: now - DAY_MS + 60000 })]);
    await mountAndConnect();
    expect(screen.getByText(/1 installment missed while the app was closed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip this window" }));
    await flushUI(4);
    flushPlans();

    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
    expect(screen.queryByText(/missed while the app was closed/i)).toBeNull();
    expect(storedPlans()[0].nextRunAt).toBeGreaterThan(now);
    expect(meterCount()).toBe("2 / 7"); // the skipped window never advanced the plan

    // The resumed schedule does not fire inside the tick either.
    await tickScheduler();
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
  });

  it("clamps missed windows to the remaining budget and completes the plan after the last approval", async () => {
    const now = Date.now();
    // 40 windows overdue but only 1 installment remains in the budget.
    seedPlans([makeSeedPlan({ paidCount: 6, nextRunAt: now - 40 * DAY_MS })]);
    submitXrplConnectRlusdPayment.mockResolvedValue({
      result: { meta: { TransactionResult: "tesSUCCESS" } },
      hash: HASH,
    });
    await mountAndConnect();

    expect(screen.getByText(/1 installment missed while the app was closed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve send" }));
    await flushUI(6);

    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1); // never 40
    expect(meterCount()).toBe("7 / 7");
    flushPlans();
    expect(storedPlans()[0].active).toBe(false); // plan complete, not driven past its total
    expect(screen.queryByRole("button", { name: "Approve send" })).toBeNull();
  });

  it("shows the recovered banner for restored, up-to-date plans", async () => {
    seedPlans([makeSeedPlan({ nextRunAt: Date.now() + DAY_MS })]);
    await mountAndConnect();
    expect(meterCount()).toBe("2 / 7");
    expect(screen.getByText(/Recovered from last session/i)).toBeTruthy();
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
  });
});

describe("mount recovery: unresolved blocks until reconciled by hash", () => {
  const seedUnresolved = () => {
    const now = Date.now();
    seedPlans([
      makeSeedPlan({
        nextRunAt: null,
        attempts: {
          "person-1760000000000:2": {
            sequence: 2,
            status: "unresolved",
            hash: HASH,
            submittedAt: now - 5000,
            amount: "1.000000",
          },
        },
      }),
    ]);
  };

  it("reconciles on mount under StrictMode: one lookup, advances exactly once, zero submits", async () => {
    seedUnresolved();
    __clientRequest.mockResolvedValue(tesSUCCESS);
    // StrictMode double-mounts effects in dev; recovery must absorb that.
    await mountAndConnect(<React.StrictMode><CadenceDashboard /></React.StrictMode>);

    expect(__clientRequest).toHaveBeenCalledTimes(1);
    expect(__clientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tx", transaction: HASH }),
    );
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
    expect(meterCount()).toBe("3 / 7"); // exactly one advance
    expect(screen.getByRole("button", { name: "Pay one installment" }).disabled).toBe(false);
  });

  it("still_unknown keeps the block: verifying state, no timer loop, unblocked only by a classifying lookup", async () => {
    seedUnresolved();
    __clientRequest.mockResolvedValue({ result: {} }); // no verdict available
    await mountAndConnect();

    expect(meterCount()).toBe("2 / 7");
    expect(screen.getByText(/Verifying installment #3 with the ledger/i)).toBeTruthy();
    expect(screen.getByText(new RegExp(HASH.slice(0, 10)))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay one installment" }).disabled).toBe(true);

    // The tick cannot dispatch (durable guard), and recovery runs no timer loop.
    await tickScheduler();
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();

    // A manual reconcile that still cannot classify keeps the block.
    fireEvent.click(screen.getByRole("button", { name: "Reconcile now" }));
    await flushUI(6);
    expect(meterCount()).toBe("2 / 7");
    expect(screen.getByRole("button", { name: "Pay one installment" }).disabled).toBe(true);

    // When the ledger finally classifies tesSUCCESS: unblock + advance once.
    __clientRequest.mockResolvedValue(tesSUCCESS);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile now" }));
    await flushUI(6);
    expect(meterCount()).toBe("3 / 7");
    expect(screen.getByRole("button", { name: "Pay one installment" }).disabled).toBe(false);
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
  });

  it("a reconciled ledger failure records a failed attempt and never advances", async () => {
    seedUnresolved();
    __clientRequest.mockResolvedValue({
      result: { validated: true, meta: { TransactionResult: "tecNO_LINE" } },
    });
    await mountAndConnect();

    expect(__clientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tx", transaction: HASH }),
    );
    expect(meterCount()).toBe("2 / 7");
    flushPlans();
    expect(storedPlans()[0].attempts["person-1760000000000:2"].status).toBe("validated_failure");
    // A validated_failure is retry-safe: the pay button is enabled again.
    expect(screen.getByRole("button", { name: "Pay one installment" }).disabled).toBe(false);
    expect(screen.getByText(/Recovered payment failed/i)).toBeTruthy();
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
  });

  it("an awaiting-signature attempt from a dead session records a failed attempt with no lookup", async () => {
    const now = Date.now();
    seedPlans([
      makeSeedPlan({
        nextRunAt: null,
        attempts: {
          "person-1760000000000:2": {
            sequence: 2,
            status: "awaiting_signature",
            hash: null,
            submittedAt: now,
            amount: "1.000000",
          },
        },
      }),
    ]);
    __clientRequest.mockResolvedValue(tesSUCCESS); // would advance if wrongly reconciled
    await mountAndConnect();

    expect(__clientRequest).not.toHaveBeenCalled(); // no hash — nothing to look up
    expect(meterCount()).toBe("2 / 7");
    flushPlans();
    expect(storedPlans()[0].attempts["person-1760000000000:2"].status).toBe("validated_failure");
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
  });
});
