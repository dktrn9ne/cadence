// Render smoke for the opening flow. Fixtures and mocks only — never a live
// seed or mnemonic: the local (desktop) import path is never exercised here.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real wallet SDK talks to browser-extension APIs jsdom does not have.
// The fake manager keeps the smoke hermetic while the component's own submit
// path runs for real. Constructors must be constructable (plain class/function):
// the component instantiates the manager and every adapter with `new`.
vi.mock("@textrp/xrpl-connect", () => {
  function FakeAdapter() {}
  class FakeWalletManager {
    constructor() {
      this.connected = false;
      this.account = null;
      this.wallet = null;
      this.on = vi.fn();
    }
  }
  return {
    WalletManager: FakeWalletManager,
    XamanAdapter: FakeAdapter,
    CrossmarkAdapter: FakeAdapter,
    GemWalletAdapter: FakeAdapter,
    XyraAdapter: FakeAdapter,
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
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
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
});
