// Dashboard-level tests for the guarded per-installment dispatcher (PR 04
// wave 3). These pin the spec's verification rows:
//
//   - "One attempt per installment across entry points" — a scheduler tick and
//     a manual click landing on the same due installment produce exactly ONE
//     build/submit call; the second dispatch is refused as already-in-flight.
//     Two plans due simultaneously BOTH dispatch (no global lock starvation).
//   - "Start-plan timer is cancellable and honest" — pausing within the start
//     timer's window cancels the submit; a submit that does fire is logged
//     source "manual", never "scheduled".
//   - Hash-less wallet resolutions record a failed attempt and never advance;
//     tec* ledger failures never advance; an unresolved attempt blocks every
//     entry point until a ledger lookup by hash classifies it.
//
// Hermetic by construction: the wallet manager, payment submitters, and the
// xrpl client are all mocked; nothing here touches the network, signs a real
// transaction, or loads secret material.
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

// The xrpl client is only reached through lookupTransaction's reconcile path;
// tests drive its verdicts via the exported request mock.
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

// An already-connected XRPL Connect session, so finishSetup short-circuits
// into handleConnectedXrplAccount without any real wallet.
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
const DEST_B = "rDestinationB2222222222222222222222222222222222";
const HASH = "9A4C7B2E5D8F1A3C6E9B2D4F7A1C8E3B6D9F2A5C8E1B4D7F0A3C6E9B2D5F8A1C";

// Balance reads go over a raw WebSocket in the app; in tests the socket never
// opens — it immediately answers with a funded RLUSD line so no modal shows.
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

const meterCount = () =>
  screen.getByText("Installments sent").parentElement.querySelector("strong").textContent;

const storedPlans = () =>
  JSON.parse(window.localStorage.getItem("cadence-plans-v1") || "{}").plans || [];

const logSources = (event) =>
  JSON.parse(window.localStorage.getItem("cadence-debug-logs-v1") || "[]")
    .filter((entry) => entry.event === event)
    .map((entry) => entry.payload?.source ?? entry.source);

async function connectWallet() {
  render(<CadenceDashboard />);
  await flushUI();
  fireEvent.click(screen.getByRole("button", { name: /Connect XRPL wallet/i }));
  await flushUI();
  expect(screen.getByText("Payment plans")).toBeTruthy();
}

async function addPerson(name, address) {
  fireEvent.click(screen.getByRole("button", { name: "+ Add person" }));
  await flushUI(4);
  fireEvent.change(screen.getByPlaceholderText("Alex Morgan"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText("r..."), { target: { value: address } });
  // savePerson ids are `person-${Date.now()}`; under fake timers two saves in
  // the same millisecond collide onto one id and the second save silently
  // updates the first plan instead of adding one. Nudge the fake clock so
  // ids stay unique.
  vi.advanceTimersByTime(1);
  fireEvent.click(screen.getByRole("button", { name: /Save cadence/i }));
  await flushUI(4);
}

function startPlan() {
  fireEvent.click(screen.getByRole("button", { name: "Start plan" }));
}

async function runStartTimer() {
  await act(async () => {
    vi.advanceTimersByTime(150);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
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

describe("guarded per-installment dispatch", () => {
  it("sends exactly one attempt when a tick and a manual click land on the same due installment", async () => {
    let resolveSubmit;
    submitXrplConnectRlusdPayment.mockImplementation(
      () => new Promise((resolve) => { resolveSubmit = resolve; }),
    );
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await flushUI(4);

    // Start-plan timer fires the (manual-source) dispatch; submit hangs.
    await runStartTimer();
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);

    // Scheduler tick while the same installment is in flight: refused.
    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);

    // Manual click while in flight: refused with a visible message.
    fireEvent.click(screen.getByRole("button", { name: "Pay one installment" }));
    await flushUI(4);
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/already in flight/i).length).toBeGreaterThan(0);

    // Wallet resolves tesSUCCESS: exactly one advance of paidCount.
    await act(async () => {
      resolveSubmit({ result: { meta: { TransactionResult: "tesSUCCESS" } }, hash: HASH });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(meterCount()).toMatch(/^1 \/ /);
  });

  it("dispatches two plans due simultaneously (per-installment lock, no global starvation)", async () => {
    submitXrplConnectRlusdPayment.mockResolvedValue({
      result: { meta: { TransactionResult: "tesSUCCESS" } },
      hash: HASH,
    });
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await flushUI(4);
    await addPerson("Sam", DEST_B);
    startPlan();
    await flushUI(4);

    await runStartTimer();

    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(2);
    const destinations = submitXrplConnectRlusdPayment.mock.calls.map((call) => call[0].destination);
    expect(destinations).toEqual(expect.arrayContaining([DEST_A, DEST_B]));
  });

  it("cancels the start-plan submit when the plan is paused within the timer window", async () => {
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await flushUI(4);
    fireEvent.click(screen.getByRole("button", { name: "Pause plan" }));
    await flushUI(4);

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    expect(submitXrplConnectRlusdPayment).not.toHaveBeenCalled();
    expect(meterCount()).toMatch(/^0 \/ /);
  });

  it("logs the start-plan payment as source manual, never scheduled", async () => {
    submitXrplConnectRlusdPayment.mockResolvedValue({
      result: { meta: { TransactionResult: "tesSUCCESS" } },
      hash: HASH,
    });
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await runStartTimer();

    expect(logSources("payment.installment.requested")).toEqual(["manual"]);
  });

  it("records a failed attempt and never advances when the wallet resolves with no hash", async () => {
    submitXrplConnectRlusdPayment.mockResolvedValue({ result: {}, hash: null });
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await runStartTimer();

    expect(meterCount()).toMatch(/^0 \/ /);
    const plan = storedPlans().find((item) => item.destination === DEST_A);
    expect(plan.attempts[`${plan.id}:0`].status).toBe("validated_failure");
    expect(screen.getAllByText(/Wallet confirmation was cancelled/i).length).toBeGreaterThan(0);

    // A failed attempt is retry-safe: a fresh user-initiated attempt may send.
    fireEvent.click(screen.getByRole("button", { name: "Pay one installment" }));
    await flushUI(4);
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(2);
  });

  it("never advances on a tec ledger failure", async () => {
    submitXrplConnectRlusdPayment.mockResolvedValue({
      result: { meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } },
      hash: HASH,
    });
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await runStartTimer();

    expect(meterCount()).toMatch(/^0 \/ /);
    const plan = storedPlans().find((item) => item.destination === DEST_A);
    expect(plan.attempts[`${plan.id}:0`].status).toBe("validated_failure");
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);
  });

  it("holds unresolved and blocks every entry point until the ledger classifies by hash", async () => {
    __clientRequest.mockResolvedValue({ result: {} }); // tx lookup: no verdict yet
    submitXrplConnectRlusdPayment.mockResolvedValue({ result: {}, hash: HASH });
    await connectWallet();
    await addPerson("Riley", DEST_A);
    startPlan();
    await runStartTimer();

    const plan = storedPlans().find((item) => item.destination === DEST_A);
    expect(plan.attempts[`${plan.id}:0`].status).toBe("unresolved");
    expect(meterCount()).toMatch(/^0 \/ /);
    expect(__clientRequest).toHaveBeenCalledWith(
      expect.objectContaining({ command: "tx", transaction: HASH }),
    );

    // Manual retry refused while unresolved...
    fireEvent.click(screen.getByRole("button", { name: "Pay one installment" }));
    await flushUI(4);
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/reconciled before another attempt/i).length).toBeGreaterThan(0);

    // ...and the scheduler tick is refused by the same durable guard.
    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    expect(submitXrplConnectRlusdPayment).toHaveBeenCalledTimes(1);
  });
});
