const XRPL_WS_URL = "wss://s1.ripple.com";

// Directives shared by every load mode. script-src stays strict ('self', no
// unsafe-eval) in production; dev-only allowances are appended in buildCsp.
const BASE_DIRECTIVES = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'"]],
  // 'unsafe-inline' is required for style attributes set by React/recharts and
  // for Vite HMR style injection; Google Fonts serves the current bundle's
  // stylesheet and font files (the local-fonts task may remove these hosts).
  ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
  ["img-src", ["'self'", "data:"]],
  ["font-src", ["'self'", "data:", "https://fonts.gstatic.com"]],
  ["connect-src", ["'self'", XRPL_WS_URL]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["form-action", ["'self'"]],
  ["frame-ancestors", ["'none'"]],
];

function buildCsp({ devServerOrigin = null } = {}) {
  const directives = new Map(BASE_DIRECTIVES.map(([name, sources]) => [name, [...sources]]));

  if (devServerOrigin) {
    // Vite injects the React-refresh preamble as an inline module script and
    // serves HMR over a ws:// socket on the dev origin. Dev only — the
    // production policy never gains an inline or eval script source.
    directives.get("script-src").push("'unsafe-inline'");
    directives.get("connect-src").push(`ws://${new URL(devServerOrigin).host}`);
  }

  return [...directives]
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

module.exports = { buildCsp, XRPL_WS_URL };
