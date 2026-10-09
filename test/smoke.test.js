import { describe, expect, it } from "vitest";

// Smoke test for the harness itself: the runner executes, jsdom provides the
// DOM environment, and vitest.setup.js cleans cadence- keys between tests.
describe("test harness smoke", () => {
  it("executes under jsdom with localStorage available", () => {
    expect(typeof localStorage).toBe("object");
    localStorage.setItem("cadence-harness-smoke", "written-in-jsdom");
    expect(localStorage.getItem("cadence-harness-smoke")).toBe("written-in-jsdom");
  });

  it("removed the cadence- key the previous test wrote (cleanup hook ran)", () => {
    expect(localStorage.getItem("cadence-harness-smoke")).toBeNull();
    // Cleanup is scoped to the cadence- prefix: foreign keys must survive.
    localStorage.setItem("unrelated-key", "keep-me");
  });

  it("left non-cadence keys untouched", () => {
    expect(localStorage.getItem("unrelated-key")).toBe("keep-me");
    localStorage.removeItem("unrelated-key");
  });
});
