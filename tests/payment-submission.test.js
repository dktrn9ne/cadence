import { beforeEach, describe, expect, it, vi } from "vitest";

const xrplState = vi.hoisted(() => ({ clients: [], failNextSubmit: false }));
const crossmarkState = vi.hoisted(() => ({ sdk: { async: {}, sync: {} } }));

vi.mock("xrpl", () => {
  class Client {
    constructor(url) {
      this.url = url;
      this.connect = vi.fn(async () => {});
      this.autofill = vi.fn(async (tx) => ({ ...tx, Fee: "12" }));
      this.submitAndWait = vi.fn(async (blob) => {
        if (xrplState.failNextSubmit) throw new Error("submission failed");
        return { status: "validated", blob };
      });
      this.disconnect = vi.fn(async () => {});
      xrplState.clients.push(this);
    }
  }
  return { Client };
});

vi.mock("@crossmarkio/sdk", () => ({ default: crossmarkState.sdk }));

import {
  submitCrossmarkRlusdPayment,
  submitRlusdPayment,
  submitXrplConnectRlusdPayment,
} from "../src/services/payments.js";
import { buildCrossmarkRlusdPayment, buildRlusdPayment } from "../src/domain/payments.js";

// Public address-shaped fixtures only — never a seed, mnemonic, or signed blob.
const PAYER = "rFixturePayerAccount00000000000000000000000";
const DESTINATION = "rFixtureDestinationAccount00000000000000000";
const AMOUNT = "12.5";

beforeEach(() => {
  xrplState.clients.length = 0;
  xrplState.failNextSubmit = false;
  crossmarkState.sdk.async = {};
  crossmarkState.sdk.sync = {};
});

describe("submitRlusdPayment", () => {
  it("connects, autofills, signs, submits, disconnects, and returns the full shape", async () => {
    const wallet = { address: PAYER, sign: vi.fn(() => ({ tx_blob: "SIGNED_BLOB", hash: "SIGNED_HASH" })) };
    const expectedPayment = buildRlusdPayment({ wallet, destination: DESTINATION, amount: AMOUNT });

    const outcome = await submitRlusdPayment({ wallet, destination: DESTINATION, amount: AMOUNT });

    expect(outcome).toEqual({
      result: { status: "validated", blob: "SIGNED_BLOB" },
      hash: "SIGNED_HASH",
      transaction: expectedPayment,
    });

    const client = xrplState.clients.at(-1);
    expect(client.url).toBe("wss://s1.ripple.com");
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.autofill).toHaveBeenCalledWith(expectedPayment);
    expect(wallet.sign).toHaveBeenCalledWith({ ...expectedPayment, Fee: "12" });
    expect(client.submitAndWait).toHaveBeenCalledWith("SIGNED_BLOB");
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects the client even when submission rejects", async () => {
    xrplState.failNextSubmit = true;
    const wallet = { address: PAYER, sign: () => ({ tx_blob: "SIGNED_BLOB", hash: "SIGNED_HASH" }) };

    await expect(submitRlusdPayment({ wallet, destination: DESTINATION, amount: AMOUNT })).rejects.toThrow(
      "submission failed"
    );

    expect(xrplState.clients.at(-1).disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("submitCrossmarkRlusdPayment", () => {
  it("signs the crossmark payment and returns the full shape", async () => {
    const response = { response: { data: { resp: { result: { hash: "CROSSMARK_HASH" } } } } };
    crossmarkState.sdk.async.signAndSubmitAndWait = vi.fn(async () => response);
    const expectedPayment = buildCrossmarkRlusdPayment({ account: PAYER, destination: DESTINATION, amount: AMOUNT });

    const outcome = await submitCrossmarkRlusdPayment({ account: PAYER, destination: DESTINATION, amount: AMOUNT });

    expect(crossmarkState.sdk.async.signAndSubmitAndWait).toHaveBeenCalledWith(expectedPayment);
    expect(outcome).toEqual({
      result: response,
      hash: "CROSSMARK_HASH",
      transaction: expectedPayment,
    });
  });
});

describe("submitXrplConnectRlusdPayment", () => {
  it("throws before submitting when the manager is not connected", async () => {
    await expect(
      submitXrplConnectRlusdPayment({ manager: { connected: false }, account: PAYER, destination: DESTINATION, amount: AMOUNT })
    ).rejects.toThrow("Connect an XRPL wallet first.");
    await expect(
      submitXrplConnectRlusdPayment({ manager: undefined, account: PAYER, destination: DESTINATION, amount: AMOUNT })
    ).rejects.toThrow("Connect an XRPL wallet first.");
  });

  it("signs and submits through a connected manager", async () => {
    const managerResult = { data: { result: { hash: "MANAGER_HASH" } } };
    const manager = { connected: true, signAndSubmit: vi.fn(async () => managerResult) };
    const expectedPayment = buildCrossmarkRlusdPayment({ account: PAYER, destination: DESTINATION, amount: AMOUNT });

    const outcome = await submitXrplConnectRlusdPayment({ manager, account: PAYER, destination: DESTINATION, amount: AMOUNT });

    expect(manager.signAndSubmit).toHaveBeenCalledWith(expectedPayment);
    expect(outcome).toEqual({
      result: managerResult,
      hash: "MANAGER_HASH",
      transaction: expectedPayment,
    });
  });
});
