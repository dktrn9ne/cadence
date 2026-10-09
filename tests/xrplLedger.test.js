import { beforeEach, describe, expect, it, vi } from "vitest";

// Contract tests for the reconciliation read (PR 04): a lookup by transaction
// hash normalizes to validated_success | validated_failure | still_unknown,
// decided only by the ledger's meta.TransactionResult. Every transport or
// server failure — and every unreadable response — resolves still_unknown:
// an unknown outcome must never be guessed as success or failure, because
// only validated_success may advance a plan.

import {
  OUTCOMES,
  classifyTransactionResult,
  lookupTransaction,
  lookupWithClient,
} from "../src/services/xrplLedger.js";

const XRPL_WS_URL = "wss://s1.ripple.com";
const HASH = "9A4C000000000000000000000000000000000000000000000000000000000F01";

// ---- pure classification -------------------------------------------------

describe("classifyTransactionResult", () => {
  it("classifies tesSUCCESS as validated_success", () => {
    expect(
      classifyTransactionResult({ meta: { TransactionResult: "tesSUCCESS" } })
    ).toBe(OUTCOMES.SUCCESS);
  });

  it("classifies every other ledger result code as validated_failure", () => {
    // tec/tef/tem/tej are all "the ledger answered, and not with success".
    for (const code of ["tecUNFUNDED_PAYMENT", "tecNO_LINE", "tefBAD_AUTH", "temBAD_CURRENCY"]) {
      expect(classifyTransactionResult({ meta: { TransactionResult: code } })).toBe(
        OUTCOMES.FAILURE
      );
    }
  });

  it("classifies an unreadable or missing verdict as still_unknown", () => {
    expect(classifyTransactionResult(undefined)).toBe(OUTCOMES.UNKNOWN);
    expect(classifyTransactionResult({})).toBe(OUTCOMES.UNKNOWN);
    expect(classifyTransactionResult({ meta: {} })).toBe(OUTCOMES.UNKNOWN);
    expect(classifyTransactionResult({ meta: { TransactionResult: "" } })).toBe(OUTCOMES.UNKNOWN);
  });
});

// ---- lookupWithClient: the mocked-client seam -----------------------------

const makeClient = (impl) => ({ request: vi.fn(impl) });

describe("lookupWithClient", () => {
  it("requests the transaction by hash and reports validated_success", async () => {
    const client = makeClient(async () => ({
      result: { hash: HASH, meta: { TransactionResult: "tesSUCCESS" } },
    }));
    await expect(lookupWithClient(client, HASH)).resolves.toEqual({
      outcome: OUTCOMES.SUCCESS,
    });
    expect(client.request).toHaveBeenCalledWith({ command: "tx", transaction: HASH });
  });

  it("reports validated_failure from ledger failure meta", async () => {
    const client = makeClient(async () => ({
      result: { hash: HASH, meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } },
    }));
    await expect(lookupWithClient(client, HASH)).resolves.toEqual({
      outcome: OUTCOMES.FAILURE,
    });
  });

  it("resolves still_unknown when the server cannot find the transaction", async () => {
    // Shape of the error the xrpl client raises for an error response.
    const txnNotFound = Object.assign(new Error("Transaction not found."), {
      name: "ResponseError",
      data: { error: "txnNotFound" },
    });
    const client = makeClient(async () => {
      throw txnNotFound;
    });
    await expect(lookupWithClient(client, HASH)).resolves.toEqual({
      outcome: OUTCOMES.UNKNOWN,
    });
  });

  it("resolves still_unknown on any transport failure", async () => {
    for (const error of [
      new Error("connection timed out"),
      new Error("socket hang up"),
      Object.assign(new Error("not connected"), { name: "NotConnectedError" }),
    ]) {
      const client = makeClient(async () => {
        throw error;
      });
      await expect(lookupWithClient(client, HASH)).resolves.toEqual({
        outcome: OUTCOMES.UNKNOWN,
      });
    }
  });

  it("resolves still_unknown when the response carries no readable meta", async () => {
    const client = makeClient(async () => ({ result: { hash: HASH } }));
    await expect(lookupWithClient(client, HASH)).resolves.toEqual({
      outcome: OUTCOMES.UNKNOWN,
    });
  });

  it("never touches the network for a missing or empty hash", async () => {
    const client = makeClient(async () => {
      throw new Error("lookup must not be attempted");
    });
    await expect(lookupWithClient(client, "")).resolves.toEqual({ outcome: OUTCOMES.UNKNOWN });
    await expect(lookupWithClient(client, null)).resolves.toEqual({ outcome: OUTCOMES.UNKNOWN });
    expect(client.request).not.toHaveBeenCalled();
  });
});

// ---- lookupTransaction: wiring against the real xrpl Client ---------------

const state = vi.hoisted(() => ({
  instances: [],
  lifecycle: [],
  connectError: null,
  requestError: null,
  requestResult: null,
  disconnectError: null,
}));

vi.mock("xrpl", () => {
  class MockClient {
    constructor(url) {
      this.url = url;
      state.instances.push(this);
    }
    async connect() {
      state.lifecycle.push("connect");
      if (state.connectError) throw state.connectError;
    }
    async request(request) {
      state.lifecycle.push("request");
      if (state.requestError) throw state.requestError;
      return state.requestResult;
    }
    async disconnect() {
      state.lifecycle.push("disconnect");
      if (state.disconnectError) throw state.disconnectError;
    }
  }
  return { Client: MockClient };
});

describe("lookupTransaction", () => {
  beforeEach(() => {
    state.instances.length = 0;
    state.lifecycle.length = 0;
    state.connectError = null;
    state.requestError = null;
    state.requestResult = null;
    state.disconnectError = null;
  });

  it("opens one client on mainnet, looks the hash up, and disconnects", async () => {
    state.requestResult = { result: { hash: HASH, meta: { TransactionResult: "tesSUCCESS" } } };
    await expect(lookupTransaction(HASH)).resolves.toEqual({ outcome: OUTCOMES.SUCCESS });
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0].url).toBe(XRPL_WS_URL);
    expect(state.lifecycle).toEqual(["connect", "request", "disconnect"]);
  });

  it("resolves still_unknown when the client cannot connect", async () => {
    state.connectError = new Error("getaddrinfo ENOTFOUND");
    await expect(lookupTransaction(HASH)).resolves.toEqual({ outcome: OUTCOMES.UNKNOWN });
    // Never connected, so there is nothing to disconnect.
    expect(state.lifecycle).toEqual(["connect"]);
  });

  it("keeps a successful classification even if disconnect fails afterwards", async () => {
    state.requestResult = { result: { hash: HASH, meta: { TransactionResult: "tesSUCCESS" } } };
    state.disconnectError = new Error("already closed");
    await expect(lookupTransaction(HASH)).resolves.toEqual({ outcome: OUTCOMES.SUCCESS });
  });

  it("returns exactly the normalized shape — nothing more", async () => {
    state.requestResult = { result: { hash: HASH, meta: { TransactionResult: "tesSUCCESS" } } };
    const outcome = await lookupTransaction(HASH);
    expect(Object.keys(outcome)).toEqual(["outcome"]);
  });

  it("resolves still_unknown for a hash-less call without constructing a client", async () => {
    await expect(lookupTransaction("")).resolves.toEqual({ outcome: OUTCOMES.UNKNOWN });
    await expect(lookupTransaction(null)).resolves.toEqual({ outcome: OUTCOMES.UNKNOWN });
    expect(state.instances).toHaveLength(0);
  });
});
