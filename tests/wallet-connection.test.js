import { beforeEach, describe, expect, it, vi } from "vitest";

const crossmarkState = vi.hoisted(() => ({ sdk: { async: {}, sync: {} } }));

vi.mock("@crossmarkio/sdk", () => ({ default: crossmarkState.sdk }));

import { connectCrossmarkWallet, getCrossmark } from "../src/services/wallet-connection.js";

const ADDR = "rFixtureCrossmarkAddress00000000000000000000";

beforeEach(() => {
  crossmarkState.sdk.async = {};
  crossmarkState.sdk.sync = {};
});

describe("getCrossmark", () => {
  it("resolves to the SDK default export", async () => {
    await expect(getCrossmark()).resolves.toBe(crossmarkState.sdk);
  });
});

describe("connectCrossmarkWallet", () => {
  it("rejects when Crossmark is neither detected nor installed", async () => {
    crossmarkState.sdk.async.detect = vi.fn(async () => false);

    await expect(connectCrossmarkWallet()).rejects.toThrow(
      "Crossmark was not detected. Install or unlock Crossmark, then try again."
    );
  });

  it("continues when detection fails but the SDK reports itself installed", async () => {
    crossmarkState.sdk.async.detect = vi.fn(async () => false);
    crossmarkState.sdk.sync.isInstalled = vi.fn(() => true);
    crossmarkState.sdk.async.connect = vi.fn(async () => ({}));
    crossmarkState.sdk.async.signInAndWait = vi.fn(async () => ({
      response: { data: { address: ADDR } },
    }));

    await expect(connectCrossmarkWallet()).resolves.toEqual({
      address: ADDR,
      signIn: { response: { data: { address: ADDR } } },
    });
    expect(crossmarkState.sdk.sync.isInstalled).toHaveBeenCalled();
  });

  it("returns the parsed address from the sign-in response", async () => {
    crossmarkState.sdk.async.detect = vi.fn(async () => true);
    crossmarkState.sdk.async.connect = vi.fn(async () => ({}));
    crossmarkState.sdk.async.signInAndWait = vi.fn(async () => ({
      response: { data: { address: ADDR } },
    }));

    await expect(connectCrossmarkWallet()).resolves.toEqual({
      address: ADDR,
      signIn: { response: { data: { address: ADDR } } },
    });
    expect(crossmarkState.sdk.async.detect).toHaveBeenCalledWith(2000);
    expect(crossmarkState.sdk.async.connect).toHaveBeenCalledWith(5000);
  });

  it("accepts the account field and falls back to sync.getAddress", async () => {
    crossmarkState.sdk.async.detect = vi.fn(async () => true);
    crossmarkState.sdk.async.connect = vi.fn(async () => ({}));
    crossmarkState.sdk.async.signInAndWait = vi.fn(async () => ({
      data: { account: ADDR },
    }));

    await expect(connectCrossmarkWallet()).resolves.toEqual({ address: ADDR, signIn: { data: { account: ADDR } } });

    crossmarkState.sdk.async.signInAndWait = vi.fn(async () => ({}));
    crossmarkState.sdk.sync.getAddress = vi.fn(() => ADDR);
    await expect(connectCrossmarkWallet()).resolves.toEqual({ address: ADDR, signIn: {} });
  });

  it("rejects on a non-XRPL address", async () => {
    crossmarkState.sdk.async.detect = vi.fn(async () => true);
    crossmarkState.sdk.async.connect = vi.fn(async () => ({}));
    crossmarkState.sdk.async.signInAndWait = vi.fn(async () => ({
      response: { data: { address: "not-an-xrpl-address" } },
    }));

    await expect(connectCrossmarkWallet()).rejects.toThrow("Crossmark did not return a valid XRPL address.");
  });
});
