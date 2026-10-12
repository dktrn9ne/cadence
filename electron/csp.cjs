const XRPL_WS_URL = "wss://s1.ripple.com";

// Directives shared by every load mode. script-src stays strict ('self', no
// unsafe-eval) in production; dev-only allowances are appended in buildCsp.
const BASE_DIRECTIVES = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'"]],
  // 'unsafe-inline' is required for style attributes set by React/recharts and
  // for Vite HMR style injection.
  ["style-src", ["'self'", "'unsafe-inline'"]],
  ["img-src", ["'self'", "data:"]],
  // Fonts are self-hosted (Karla ships via @fontsource since PR #31); no
  // remote font host belongs in the policy.
  ["font-src", ["'self'", "data:"]],
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
