// One writer for all payment state in this origin. No expiring localStorage
// leases: a suspended tab must not lose ownership while a wallet prompt is open.
export const PAYMENT_SESSION_LOCK = "cadence-payment-session-v1";

export function acquirePaymentSession({ locks = globalThis.navigator?.locks, onState, onAcquire }) {
  let cancelled = false;
  let releaseLock;
  let operations = 0;
  let owned = false;
  const releaseIfIdle = () => {
    if (cancelled && operations === 0) {
      owned = false;
      releaseLock?.();
    }
  };
  if (!locks?.request) {
    onState("unsupported");
    return { close() {}, beginOperation: () => null, isOwner: () => false };
  }
  onState("acquiring");
  // Defer acquisition so StrictMode cleanup can cancel its discarded mount.
  const request = Promise.resolve().then(() => {
    if (cancelled) return;
    return locks.request(PAYMENT_SESSION_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (cancelled) return;
      if (!lock) { onState("blocked"); return; }
      const held = new Promise((resolve) => { releaseLock = resolve; });
      owned = true;
      try {
        onAcquire?.();
        onState("ready");
        await held;
      } finally {
        owned = false;
      }
    });
  });
  request.catch(() => { if (!cancelled) onState("unsupported"); });
  return {
    close() { cancelled = true; releaseIfIdle(); },
    isOwner: () => owned,
    beginOperation() {
      if (!owned || cancelled) return null;
      operations += 1;
      let done = false;
      return () => { if (!done) { done = true; operations -= 1; releaseIfIdle(); } };
    },
  };
}
