# Cadence — Agent Guidance

Repo: **dktrn9ne/cadence** — "Cadence on XRP", a consumer wallet dashboard for RLUSD income
verification and scheduled XRP Ledger payments. Single-page React app with an optional
Electron desktop wrapper. Pure frontend: no backend service, no database, no required
environment variables. External runtime dependency is XRPL mainnet (`wss://s1.ripple.com`),
contacted only when a user connects a wallet or requests ledger data.

## Stack

- **Runtime:** Node.js 20 (verified on 20.20.2), npm 10 (package-lock.json is the tracked lockfile; ignore stray `bun.lock`)
- **Web app:** React 19 + Vite 7 (`src/main.jsx` → `src/CadenceDashboard.jsx`; schedule/payment/wallet logic lives in `src/domain/` and `src/services/`, presentation in `src/brand/`)
- **Desktop:** Electron 39 wrapper loading the Vite dev server (`electron/main.cjs`, `electron/dev-runner.cjs`)
- **XRPL libs:** `xrpl`, `@textrp/xrpl-connect`, `@crossmarkio/sdk`; charts via `recharts`
- **Deploy:** Vercel (`vercel.json`, SPA rewrite to index.html)

## Commands

```bash
npm install            # install deps
npm run dev            # Vite dev server → http://127.0.0.1:5173/ (port from vite.config.js; confirmed in startup output)
npm run desktop:dev    # starts Vite if not running, then Electron window (CADENCE_DEV_SERVER_URL)
npm run build          # production build → dist/
npm run desktop        # build then launch Electron with built assets
npm run preview        # serve dist/
npm test               # vitest run — full suite once, never watches
npm run test:watch     # vitest watch mode for iteration
```

There is **no lint or typecheck** — `npm test` and `npm run build` are the available static
proof. Dev-server health check: `curl -sf http://127.0.0.1:5173/`.

## Codebase map

| Path | Role |
|---|---|
| `src/main.jsx` | React entry; mounts `CadenceDashboard` into `#root` |
| `src/CadenceDashboard.jsx` | The UI: opening/connect screen, employer + employee dashboards, income proof, payment flows, XRPL signing |
| `src/domain/` | Pure logic: XRPL constants (`xrpl-constants.js`), schedule math (`schedule.js`), payment builders (`payments.js`), payer-aware income proof (`incomeProof.js`), installment outcome machines (`installment.js`) |
| `src/services/` | I/O over wallet SDKs: payment submitters (`payments.js`), Crossmark/xrpl-connect accessors (`wallet-connection.js`), transaction-hash reconciliation (`xrplLedger.js`) |
| `src/storage/` | Durable state: versioned plan/attempt store (`planState.js`) |
| `src/brand/` | Presentation identity: tokens (`tokens.js`, midnight palette + theme), `CadenceMark.jsx`, `app-icon.png` |
| `tests/` | Vitest suites: `app.smoke.test.jsx` (render smoke), domain/service contract tests, token pins |
| `.github/workflows/ci.yml` | GitHub Actions: `npm ci`, `npm test -- --run`, `npm run build`, dist artifact |
| `electron/main.cjs` | Electron main process; window creation, renderer console logging, dev-server URL via `CADENCE_DEV_SERVER_URL` |
| `electron/dev-runner.cjs` | Waits for Vite on 127.0.0.1:5173, spawns Electron |
| `index.html` | Vite entry HTML |
| `vite.config.js` | React plugin, `base: "./"`, dev host 127.0.0.1:5173 |
| `vercel.json` | Vercel build config + SPA rewrite |
| `latest.zip` | Prebuilt downloadable bundle referenced by the README |
| `streampay-technical-brief.docx` | Product/technical brief document |

## XRPL constants (from README; canonical values in `src/domain/xrpl-constants.js`)

- Network: XRPL mainnet, WS `wss://s1.ripple.com`
- Asset: RLUSD, issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- Cadence employer wallet: `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`; source tag `2606250005`
- Income verification filters incoming RLUSD payments from the employer wallet by that source tag

## Local verification (validated 2026-10-09)

1. `npm run dev` — Vite 7.3.6 ready on `http://127.0.0.1:5173/`, HTTP 200, clean startup log.
2. Headless Chromium load: title "Cadence on XRPL", opening screen renders, **zero console/page errors**;
   screenshot captured during onboarding. Clicking "Connect XRPL wallet" advances to the wallet-selection
   step; a full connection requires a real external XRP wallet (Xaman/Crossmark/GemWallet/Xyra) and
   cannot be completed headlessly — expected boundary, not a defect.
3. `npm run build` — succeeds in ~5s (chunk-size warnings only).

### Environment notes

- If `node_modules` arrives root-owned, Vite's dep optimizer fails with EACCES under `node_modules/.vite`:
  fix with `sudo chown -R $(id -u):$(id -g) node_modules` and restart.
- No `.env` needed; no secrets required for local dev. `.env`/`.env.local` are gitignored.
- Primary user flow beyond wallet selection needs an external XRPL wallet on mainnet; do not sign real
  transactions during automated verification.

## Sandbox snapshot

- Snapshot ID: `yb6k43tuimveekdb8ynn:default`
- Captured: 2026-10-09T16:25:44.841Z
- State: deps installed, `node_modules` chowned to `user`, Vite dev server running on 127.0.0.1:5173 (tmux session `cadence`), production build verified
