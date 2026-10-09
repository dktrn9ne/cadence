---
name: local-dev
description: How to get the Cadence web/desktop app running locally in this sandbox
recorded: 2026-10-09
---

# Skill: local-dev (Cadence)

Durable record of the LOCAL-DEV onboarding run for dktrn9ne/cadence (2026-10-09).

## Stack facts

- Node 20 (≥20.19 required by Vite 7), npm 10, `package-lock.json` is authoritative. A stray
  root-owned `bun.lock` exists from image build; ignore it — do not run bun.
- Pure frontend: no database, no queue, no env vars, no secrets needed for local dev.
- XRPL mainnet (`wss://s1.ripple.com`) is contacted only at runtime when a user connects a
  wallet or loads ledger data; it is not needed to boot the dev server.

## Bring-up procedure

1. **Fix ownership if needed.** The base image ships `node_modules` (and `bun.lock`) owned by
   root. Vite's dep optimizer then fails with `EACCES ... node_modules/.vite/deps_temp_*`.
   Fix: `sudo chown -R $(id -u):$(id -g) node_modules` (sudo is available to user 1000).
2. **Start the dev server** in tmux: `tmux new-session -d -s cadence 'npm run dev 2>&1 | tee /tmp/vite.log'`.
   Parsed startup output: `VITE v7.3.6 ready` → `Local: http://127.0.0.1:5173/` (port comes from
   `vite.config.js`; verify in `/tmp/vite.log` rather than assuming).
3. **Health check:** `curl -sf http://127.0.0.1:5173/` → HTTP 200 with the Vite-injected index.html.
4. **Browser verification (evidence):** Playwright headless chromium-headless-shell works. Binary lives in
   `~/.cache/ms-playwright/chromium_headless_shell-1148`; system libs were installed via apt
   (libnss3, libgbm1, libatk*, libasound2(t64), libxkbcommon0, etc.). Do NOT use
   `playwright install --with-deps` — it fails on `ttf-ubuntu-font-family` (no apt candidate);
   install the lib list manually instead. Helper scripts: `/tmp/pw/*.cjs` (not persisted).
5. **What renders:** title "Cadence on XRP"; opening screen with "Connect XRPL wallet".
   Zero console/page errors on load. Clicking Connect reaches the wallet-selection step and then
   logs a handled `WalletError` (Xaman needs an API key/extension) — that is the expected
   boundary: a full connection needs a real external XRP wallet and cannot be automated headlessly.
6. **Static proof:** `npm run build` (~5s, exit 0; only chunk-size warnings). There are no
   lint/typecheck/test scripts in this repo — do not look for them.

## Gotchas

- Port 5173 is fixed in `vite.config.js` (host 127.0.0.1). `npm run desktop:dev` starts Vite
  itself if the port is free, then spawns Electron (needs a display — use the web flow headless).
- After a Vite crash, kill the tmux session and remove any stale `node_modules/.vite` before restarting.
- Real XRPL mainnet transactions can be signed by this app — never wire real seed phrases into
  automated verification.

## Validation summary (2026-10-09)

- Dev server: healthy (HTTP 200, clean log, port 5173 confirmed from output)
- Primary flow: opening screen rendered in headless Chromium, 0 console errors, screenshot captured;
  connect-wallet step exercised up to the external-wallet boundary
- Build: passing
- dev_stack_healthy: true
