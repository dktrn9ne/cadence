import { describe, expect, it, vi } from "vitest";
import { acquirePaymentSession } from "./paymentSession.js";

function locksFixture() {
  let held = false;
  return { request: vi.fn(async (_name, _options, callback) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({ name: "fixture" }); } finally { held = false; }
  }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("payment session ownership", () => {
  it("permits one writer, blocks a second, and reads fresh state only after acquisition", async () => {
    const locks = locksFixture();
    const firstState = vi.fn(), secondState = vi.fn(), read = vi.fn();
    const first = acquirePaymentSession({ locks, onState: firstState, onAcquire: read });
    await flush();
    const second = acquirePaymentSession({ locks, onState: secondState, onAcquire: read });
    await flush();
    expect(first.isOwner()).toBe(true);
    expect(second.isOwner()).toBe(false);
    expect(second.beginOperation()).toBeNull();
    expect(secondState).toHaveBeenLastCalledWith("blocked");
    expect(read).toHaveBeenCalledTimes(1);
    first.close(); await flush();
    const third = acquirePaymentSession({ locks, onState: vi.fn(), onAcquire: read });
    await flush();
    expect(third.isOwner()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    third.close(); second.close(); await flush();
  });

  it("holds ownership through an in-flight operation even after unmount", async () => {
    const locks = locksFixture();
    const first = acquirePaymentSession({ locks, onState: vi.fn() });
    await flush();
    const finish = first.beginOperation();
    first.close(); await flush();
    expect(first.isOwner()).toBe(true);
    const second = acquirePaymentSession({ locks, onState: vi.fn() });
    await flush(); expect(second.isOwner()).toBe(false);
    finish(); await flush(); expect(first.isOwner()).toBe(false);
    second.close();
  });

  it("does not claim a discarded StrictMode mount", async () => {
    const locks = locksFixture();
    const discarded = acquirePaymentSession({ locks, onState: vi.fn() });
    discarded.close();
    const active = acquirePaymentSession({ locks, onState: vi.fn() });
    await flush(); expect(active.isOwner()).toBe(true);
    expect(locks.request).toHaveBeenCalledTimes(1);
    active.close(); await flush();
  });

  it("fails closed when Web Locks is unavailable", () => {
    const onState = vi.fn();
    const session = acquirePaymentSession({ locks: {}, onState });
    expect(onState).toHaveBeenCalledWith("unsupported");
    expect(session.beginOperation()).toBeNull();
  });
});
