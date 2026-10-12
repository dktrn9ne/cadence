import { beforeEach, describe, expect, it, vi } from "vitest";

const crossmarkState = vi.hoisted(() => ({ sdk: { async: {}, sync: {} } }));

vi.mock("@crossmarkio/sdk", () => ({ default: crossmarkState.sdk }));

import {
  connectCrossmarkWallet,
  getCrossmark,
  installDerivedColorLoopGuard,
  openWalletPicker,
} from "../src/services/wallet-connection.js";

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

// The vendored picker element derives hover colors in updateDerivedColors(),
// which writes inline style custom properties to the element its own
// MutationObserver watches (attributeFilter: ["style"]). On Chromium builds
// that queue a style-attribute mutation record for every setProperty call —
// even same-value ones — that write/observe pair loops forever and starves
// every timer, so the picker's availability sweep never settles and the
// picker never mounts. These tests pin our guard, not the SDK internals.
describe("installDerivedColorLoopGuard", () => {
  const DERIVED = [
    ["--xc-primary-button-hover-background", "#34cbff"],
    ["--xc-connect-button-hover-background", "#262c5d"],
    ["--xc-account-address-button-hover-color", "#34cbff"],
  ];

  // Mirrors the vendored element shape the guard meets: updateDerivedColors on
  // the prototype, style attribute reads via getAttribute, writes via the
  // inline CSSStyleDeclaration.
  const makeFakeConnector = () => {
    const prototype = {
      updateDerivedColors() {
        this.deriveCalls += 1;
        for (const [name, value] of DERIVED) {
          this.style.setProperty(name, value);
        }
      },
    };
    const element = Object.create(prototype);
    const decls = new Map();
    element.deriveCalls = 0;
    element.writeCalls = 0;
    element.getAttribute = (name) =>
      name === "style"
        ? [...decls.entries()].map(([n, v]) => `${n}: ${v};`).join(" ")
        : null;
    element.style = {
      setProperty: (name, value) => {
        element.writeCalls += 1;
        decls.set(name, value);
      },
    };
    return element;
  };

  it("stops the write/observe loop once the style attribute stops changing", () => {
    const element = makeFakeConnector();

    expect(installDerivedColorLoopGuard(element)).toBe(true);

    // First delivery (the element upgrade's rAF): one real derivation.
    element.updateDerivedColors();
    expect(element.deriveCalls).toBe(1);

    // A second delivery still re-derives once: the first pass changed the
    // style attribute (empty -> three properties), so the observer fires and
    // the derivation legitimately runs against the new value...
    element.updateDerivedColors();
    expect(element.deriveCalls).toBe(2);

    // ...but from here the attribute is stable. Whatever re-notifies the
    // observer (a Chromium that records same-value setProperty calls), the
    // guard must refuse to re-derive, ending the loop instead of starving
    // every timer.
    for (let i = 0; i < 5000; i += 1) {
      element.updateDerivedColors();
    }
    expect(element.deriveCalls).toBe(2);
    expect(element.writeCalls).toBe(6); // 3 properties x 2 derivations, never again
  });

  it("re-derives when the style attribute genuinely changes", () => {
    const element = makeFakeConnector();
    installDerivedColorLoopGuard(element);

    element.updateDerivedColors();
    element.updateDerivedColors();
    expect(element.deriveCalls).toBe(2);

    // Simulate an external writer (theme swap, React style prop) changing the
    // element's inline style — the next observer delivery must derive again.
    element.style.setProperty("--xc-primary-color", "#ff0000");
    element.updateDerivedColors();
    expect(element.deriveCalls).toBe(3);
  });

  it("guards each element instance independently", () => {
    const elementA = makeFakeConnector();
    const elementB = makeFakeConnector();
    installDerivedColorLoopGuard(elementA);

    elementA.updateDerivedColors();
    elementA.updateDerivedColors();
    elementB.updateDerivedColors();
    elementB.updateDerivedColors();

    // Same prototype: A's baseline never suppresses B's derivations.
    expect(elementA.deriveCalls).toBe(2);
    expect(elementB.deriveCalls).toBe(2);
  });

  it("ignores elements without the vendored derivation method", () => {
    expect(installDerivedColorLoopGuard(document.createElement("div"))).toBe(false);
    expect(installDerivedColorLoopGuard(null)).toBe(false);
  });
});

describe("openWalletPicker", () => {
  it("resolves with the connector's own open() result", async () => {
    const connector = { open: vi.fn(async () => "opened") };

    await expect(openWalletPicker(connector, 1000)).resolves.toBe("opened");
  });

  it("propagates an immediate open() rejection instead of waiting for the timeout", async () => {
    const connector = {
      open: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(openWalletPicker(connector, 10000)).rejects.toThrow("boom");
  });

  it("rejects with an actionable error when the picker never opens", async () => {
    vi.useFakeTimers();
    try {
      const connector = { open: () => new Promise(() => {}) };
      const pending = openWalletPicker(connector, 5000);
      // Attach the rejection handler before advancing the fake clock: the
      // async timer advance crosses a macrotask boundary, and a rejection
      // with no handler at that boundary is reported as unhandled.
      const expectation = expect(pending).rejects.toThrow(
        "The wallet picker did not open. Refresh the page and try again."
      );

      await vi.advanceTimersByTimeAsync(5000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout timer when the picker opens first", async () => {
    vi.useFakeTimers();
    try {
      const connector = { open: async () => "opened" };

      await expect(openWalletPicker(connector, 5000)).resolves.toBe("opened");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

