// Xaman's OAuth flow needs a developer API key; Cadence ships none. The key
// arrives (if ever) through the build environment only — absent, empty, or
// whitespace-only yields null, and the value is never logged or persisted.
// Missing key = a disabled wallet option in the UI, never an error.
export const readXamanApiKey = (env = import.meta.env) => {
  const raw = env?.VITE_XAMAN_API_KEY;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
};

export const getXrplConnect = async () => import("@textrp/xrpl-connect");

// --- Wallet-picker mount guards ---------------------------------------------
// The vendored picker element (xrpl-connect's <xrpl-wallet-connector>) derives
// hover colors in updateDerivedColors(), which writes inline style properties
// to the element — the same element its own MutationObserver watches
// (attributeFilter: ["style"]). On Chromium builds that queue a style-attribute
// mutation record for every CSSStyleDeclaration.setProperty call, even when the
// serialized value is unchanged (observed deterministically on
// chromium_headless_shell-1148, 2026-10-12), that observer/write pair never
// converges: an infinite microtask loop pins the renderer main thread and
// starves every timer, so the SDK's availability sweep in open() (which races
// adapter handshakes against setTimeout deadlines) never settles and render()
// is never reached — the picker never mounts, with no console error.
//
// The guard below lives at our layer (no additional SDK patch): skip the
// re-derivation whenever the element's style attribute has not actually
// changed since the previous derivation. A genuine attribute change still
// re-derives, so SDK theming behavior is preserved.
const derivedColorGuardedPrototypes = new WeakSet();

export const installDerivedColorLoopGuard = (element) => {
  if (!element) {
    return false;
  }
  const prototype = Object.getPrototypeOf(element);
  if (
    !prototype ||
    typeof prototype.updateDerivedColors !== "function" ||
    derivedColorGuardedPrototypes.has(prototype)
  ) {
    return false;
  }
  const derive = prototype.updateDerivedColors;
  const lastDerivedStyle = new WeakMap();
  prototype.updateDerivedColors = function () {
    const currentStyle = this.getAttribute("style");
    if (lastDerivedStyle.get(this) === currentStyle) {
      return; // style attribute unchanged — this derivation was already applied
    }
    lastDerivedStyle.set(this, currentStyle);
    derive.call(this);
  };
  derivedColorGuardedPrototypes.add(prototype);
  return true;
};

// Defense-in-depth for open(): the SDK awaits the adapter availability sweep
// before render(), and each adapter's handshake is only bounded by its own
// timers. Those timers work once the loop guard above keeps the event loop
// alive, but any future SDK hang must surface as a catchable setup error —
// never as a silently dead click. finishSetup already renders the thrown
// message through setSetupError.
export const PICKER_OPEN_TIMEOUT_MS = 10000;

export const openWalletPicker = async (connector, timeoutMs = PICKER_OPEN_TIMEOUT_MS) => {
  const opening = connector.open();
  // If the timeout wins the race, the late-opening promise must not surface as
  // an unhandled rejection; the timeout error is the one we report.
  opening.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      opening,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The wallet picker did not open. Refresh the page and try again.")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
