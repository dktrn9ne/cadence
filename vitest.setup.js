import { afterEach } from "vitest";

// House rules for Cadence tests:
// 1. Tests never touch the network — no wss://s1.ripple.com; the ledger client is injected/mocked.
// 2. Tests never hold secrets — no mnemonics, seeds, or private keys in fixtures.
// 3. Use fake timers whenever time is involved (retry delays, scheduler ticks) so CI stays deterministic.

// Wipe cadence- prefixed localStorage keys after every test so suites stay
// order-independent; the attempt store (PR 03) persists under this namespace.
afterEach(() => {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && key.startsWith("cadence-")) {
      localStorage.removeItem(key);
    }
  }
});
