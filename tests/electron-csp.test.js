import { describe, expect, it } from "vitest";
import { buildCsp } from "../electron/csp.cjs";

describe("buildCsp", () => {
  it("keeps the production policy strict: script-src 'self', no unsafe-eval", () => {
    const csp = buildCsp();

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' wss://s1.ripple.com");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows only the sources the bundle actually loads", () => {
    const csp = buildCsp();

    // Google Fonts stylesheet + font files until the local-fonts task lands.
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' data: https://fonts.gstatic.com");
  });

  it("adds dev-only inline-script and HMR websocket allowances without unsafe-eval", () => {
    const csp = buildCsp({ devServerOrigin: "http://127.0.0.1:5173" });

    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("ws://127.0.0.1:5173");
    expect(csp).toContain("connect-src 'self' wss://s1.ripple.com ws://127.0.0.1:5173");
    expect(csp).not.toContain("unsafe-eval");
  });
});
