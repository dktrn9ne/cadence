import { describe, expect, it } from "vitest";

// Wave-1 smoke test: proves the harness works without rendering the app or
// changing any app behavior. Importing the dashboard module must resolve
// cleanly; nothing inside it is executed beyond module scope.
describe("vitest harness", () => {
  it("runs tests inside the jsdom environment", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
    expect(typeof document.createElement("div").ownerDocument).toBe("object");
  });

  it("resolves imports from src/ (dashboard default-exports a component)", async () => {
    const dashboard = await import("./StreamPayDashboard.jsx");
    expect(typeof dashboard.default).toBe("function");
  });
});
