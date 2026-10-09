// Render smoke for the opening flow. Fixtures and mocks only — never a live
// seed or mnemonic: the local (desktop) import path is never exercised here.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real wallet SDK talks to browser-extension APIs jsdom does not have.
// The fake manager keeps the smoke hermetic while the component's own submit
// path runs for real. Constructors must be constructable (plain class/function):
// the component instantiates the manager and every adapter with `new`.
const { adapterCalls, managerBehavior } = vi.hoisted(() => ({
  // Records every adapter construction: id -> array of constructor options.
  adapterCalls: { xaman: [], crossmark: [], gemwallet: [], xyra: [] },
  // Flipped by tests to simulate the real WalletManager/XamanAdapter throwing
  // when no Xaman API key is configured ("API key is required for Xaman").
  managerBehavior: { throwOnConstruct: false },
}));

vi.mock("@textrp/xrpl-connect", () => {
  const record = (id) =>
    function Adapter(options) {
      adapterCalls[id].push(options ?? null);
    };
  class FakeWalletManager {
    constructor(config) {
      if (managerBehavior.throwOnConstruct) {
        throw new Error("API key is required for Xaman. Please provide it in connect options or adapter constructor.");
      }
      this.config = config;
      this.connected = false;
      this.account = null;
      this.wallet = null;
      this.on = vi.fn();
    }
  }
  return {
    WalletManager: FakeWalletManager,
    XamanAdapter: record("xaman"),
    CrossmarkAdapter: record("crossmark"),
    GemWalletAdapter: record("gemwallet"),
    XyraAdapter: record("xyra"),
  };
});

import CadenceDashboard from "../src/CadenceDashboard.jsx";

// Stand-in for the <xrpl-wallet-connector> web component: `open()` is how the
// real connector shows the wallet-selection panel.
class FakeXrplWalletConnector extends HTMLElement {
  constructor() {
    super();
    this.openCalls = 0;
  }
  open() {
    this.openCalls += 1;
  }
  setWalletManager() {}
}

customElements.define("xrpl-wallet-connector", FakeXrplWalletConnector);

const renderedConnector = () => document.querySelector("xrpl-wallet-connector");

describe("Cadence opening flow (web)", () => {
  let consoleError;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    for (const id of Object.keys(adapterCalls)) adapterCalls[id] = [];
    managerBehavior.throwOnConstruct = false;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders the opening screen with the connect-wallet button", () => {
    render(<CadenceDashboard />);

    expect(screen.getByRole("heading", { name: /your wallet/i })).toBeDefined();
    expect(
      screen.getByRole("button", { name: /connect xrpl wallet/i })
    ).toBeDefined();
    // Web-mode intro form carries the connect action (folded from the earlier
    // foundation-branch smoke test).
    expect(document.querySelector("p.eyebrow")?.textContent).toBe("Connect XRPL wallet");
    expect(document.querySelector("form.intro-connect-form")).not.toBeNull();
    expect(renderedConnector()).not.toBeNull();
    // Web mode, not the desktop seed-import form.
    expect(screen.queryByText(/wallet import type/i)).toBeNull();
  });

  it("advances to wallet selection without importing any secret", async () => {
    render(<CadenceDashboard />);

    fireEvent.click(
      screen.getByRole("button", { name: /connect xrpl wallet/i })
    );

    await waitFor(() => {
      expect(renderedConnector()?.openCalls).toBe(1);
    });
    // The submit path opened the wallet picker instead of failing over to an
    // error or the desktop seed-import form.
    expect(screen.queryByText(/wallet import type/i)).toBeNull();
    expect(screen.queryByText(/could not connect xrpl wallet/i)).toBeNull();
  });

  it("opens the picker with zero console errors and no Xaman adapter when no API key is configured", async () => {
    render(<CadenceDashboard />);

    fireEvent.click(
      screen.getByRole("button", { name: /connect xrpl wallet/i })
    );

    await waitFor(() => {
      expect(renderedConnector()?.openCalls).toBe(1);
    });

    // No key configured → the Xaman adapter is never constructed, so the
    // connector's init check cannot log "API key is required for Xaman".
    expect(adapterCalls.xaman).toEqual([]);
    expect(adapterCalls.crossmark).toHaveLength(1);
    expect(adapterCalls.gemwallet).toHaveLength(1);
    expect(adapterCalls.xyra).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("shows Xaman as a clean disabled option with an inline hint when no API key is configured", () => {
    render(<CadenceDashboard />);

    const note = screen.getByRole("note", { name: /xaman unavailable/i });
    expect(note.textContent).toMatch(/no xaman api key configured/i);
    // Disabled state, never a live button that could error on click.
    expect(
      screen.queryByRole("button", { name: /xaman/i })
    ).toBeNull();
  });

  it("omits xaman from the connector wallets attribute until an API key is configured", () => {
    render(<CadenceDashboard />);

    expect(renderedConnector().getAttribute("wallets")).toBe("crossmark,gemwallet,xyra");
    expect(renderedConnector().getAttribute("primary-wallet")).toBeNull();
  });

  it("registers the Xaman adapter with the configured key when VITE_XAMAN_API_KEY is set", async () => {
    vi.stubEnv("VITE_XAMAN_API_KEY", "test-key-from-env");

    render(<CadenceDashboard />);

    fireEvent.click(
      screen.getByRole("button", { name: /connect xrpl wallet/i })
    );

    await waitFor(() => {
      expect(renderedConnector()?.openCalls).toBe(1);
    });

    expect(adapterCalls.xaman).toEqual([{ apiKey: "test-key-from-env" }]);
    // The picker lists Xaman again and offers it as the primary option.
    expect(renderedConnector().getAttribute("wallets")).toBe("xaman,crossmark,gemwallet,xyra");
    expect(renderedConnector().getAttribute("primary-wallet")).toBe("xaman");
    // No disabled-state note while the key is configured.
    expect(screen.queryByRole("note", { name: /xaman unavailable/i })).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps the console clean across three picker opens with no API key", async () => {
    render(<CadenceDashboard />);
    const connect = screen.getByRole("button", { name: /connect xrpl wallet/i });

    for (const expected of [1, 2, 3]) {
      fireEvent.click(connect);
      await waitFor(() => {
        expect(renderedConnector()?.openCalls).toBe(expected);
      });
    }

    expect(adapterCalls.xaman).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("degrades a manager construction failure to the inline error instead of crashing", async () => {
    managerBehavior.throwOnConstruct = true;
    render(<CadenceDashboard />);

    fireEvent.click(
      screen.getByRole("button", { name: /connect xrpl wallet/i })
    );

    // The adapter error degrades to the intro form's inline error banner.
    await waitFor(() => {
      expect(screen.getByText(/wallet connection could not start/i)).toBeDefined();
    });
    // The app is still interactive — the connect button remains actionable.
    expect(
      screen.getByRole("button", { name: /connect xrpl wallet/i })
    ).toBeDefined();
  });
});
