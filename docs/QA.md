# Cadence QA — Scheduler Recovery & Reconciliation Matrix

The scheduler's safety contract lives in code and tests; this matrix is the human
check. Exercise it on XRPL mainnet before each release. Every row is a failure
case from the PR 04 scheduler-recovery spec, with the behavior a person should
observe and the automated test that already pins the core rule in CI.

**Scope:** installment dispatch, plan persistence, mount recovery, hash
reconciliation, and the Electron desktop shell (own section below). Out of scope
here: income proof and wallet onboarding itself.

## How to use this matrix

- **Automated proof** names the CI test that pins the rule (`npm test` runs all
  of them; they are the release gate's first half).
- **On mainnet** describes what a human exercises before a release. Full wallet
  flows need an external XRPL wallet (Xaman / Crossmark / GemWallet / Xyra);
  automated verification never signs real transactions.
- **Result** records the latest release-gate run (date, release-branch head).
- Any ❌ row blocks the release gate by design — fix before ship.

## The contract in one line

An installment moves `scheduled → awaiting_signature → submitted →
validated_success | validated_failure | unresolved`. Only `validated_success`
(`meta.TransactionResult === "tesSUCCESS"`) advances the plan's paid count.
`unresolved` exits **only** via a ledger lookup by transaction hash — never a
timer, never a fresh submission. One active attempt per installment across every
entry point (scheduler tick, "Pay one installment", plan-start payment).
Scheduled failures never silently retry; the window is unscheduled and retry is
a fresh, user-initiated action.

## The matrix

Latest release-gate run: **2026-10-09 · `release/pr04-scheduler-recovery` @ `49c5e6b` · 188/188 tests · build green**.
Re-run the full gate on every release candidate and record the head SHA here.

| #  | Scenario | Expected result | Result | Automated proof |
|----|----------|-----------------|--------|-----------------|
| R1 | Tick and manual click race the same due installment | Exactly one build/submit for that installment; the second dispatch is refused (`already-in-flight`) and the meter does not move for the loser. | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "sends exactly one attempt when a tick and a manual click land on the same due installment" |
| R2 | Two plans due simultaneously | Both dispatch. The lock is per installment (`planId:sequence`), never global — plan B is not starved while plan A pays. | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "dispatches two plans due simultaneously (per-installment lock, no global starvation)" |
| R3 | Pause within the start-plan timer window | The queued start-plan submit never fires; no attempt record appears. Wallet reset and unmount cancel the timer the same way. | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "cancels the start-plan submit when the plan is paused within the timer window" |
| R4 | Start-plan payment honesty | The plan-start payment dispatches as `source: "manual"` through the guarded door — never labeled "scheduled". | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "logs the start-plan payment as source manual, never scheduled" |
| R5 | Wallet resolves with no hash (rejected signing / unusable response) | A failed attempt is recorded; the plan never advances; the UI shows the failure reason ("Wallet confirmation was cancelled."); a scheduled send is unscheduled. | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "records a failed attempt and never advances when the wallet resolves with no hash"; `src/domain/installment.test.js` — "records a hash-less wallet rejection as a failed attempt" |
| R6 | Ledger failure with a readable result code (`tec*`/`tef*`/`tem*`) | The attempt settles `validated_failure`: no advance, the transaction hash is preserved as evidence, and a scheduled send is unscheduled instead of silently retried. | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "never advances on a tec ledger failure"; `src/domain/installment.test.js` — "produces validated_success on tesSUCCESS meta exactly once" (the negative side) |
| R7 | Outcome unknown (unreadable meta, `txnNotFound`, transport failure, `validated: false`) | The lookup resolves `still_unknown`; the attempt is persisted `unresolved` and **every entry point is blocked** (manual shows "Verifying with ledger", the tick skips the plan, plan-start refuses) until a ledger lookup by hash classifies it. | ✅ | `src/CadenceDashboard.dispatch.test.jsx` — "holds unresolved and blocks every entry point until the ledger classifies by hash"; `tests/xrplLedger.test.js` — "resolves still_unknown on any transport failure", "keeps a transaction that is not yet validated unresolved…" |
| R8 | Reload mid-flight (attempt persisted at `submitted` with its hash) | On mount, reconciliation classifies the attempt by hash **before anything dispatches**; a validated attempt advances the meter exactly once; zero submit calls during recovery. | ✅ | `src/CadenceDashboard.recovery.test.jsx` — "reconciles on mount under StrictMode: one lookup, advances exactly once, zero submits" |
| R9 | Ledger unreachable during recovery | `still_unknown` keeps the installment blocked; the card shows "Verifying installment #N with the ledger…" with the stored hash; there is **no timer loop and no blind retry** — reconciliation re-runs on the next mount or via "Reconcile now". | ✅ | `src/CadenceDashboard.recovery.test.jsx` — "still_unknown keeps the block: verifying state, no timer loop, unblocked only by a classifying lookup"; `tests/xrplLedger.test.js` — "resolves still_unknown when the client cannot connect" |
| R10 | Plan paused while the app was closed | Paused plans restore inactive (`active: false` persists); missed windows are counted only for active plans; a submitted transaction is never mislabeled by the pause. | ✅ | `src/domain/recovery.js` Phase B skips `active !== true` plans; `src/CadenceDashboard.recovery.test.jsx` — "restores a paidCount 2 plan with an in-past nextRunAt: zero submits, missed window waits for approval" |
| R11 | Missed windows after an absence | The count is clamped to the remaining installment budget (clock drift cannot drive a plan past its total). Each **Approve send** dispatches exactly one installment through the guarded door (source `manual`); **Skip this window** submits nothing and slides the schedule one period forward. | ✅ | `src/CadenceDashboard.recovery.test.jsx` — "approval of a second missed window sends exactly one more installment (no burst)", "skipping the missed window submits nothing and slides the schedule past the abandoned window", "clamps missed windows to the remaining budget and completes the plan after the last approval"; `src/domain/recovery.test.js` — "clamps to the remaining installment budget…" |
| R12 | StrictMode dev double-mount | Recovery is idempotent: one lookup per attempt, the advance happens exactly once, and no dispatch ever runs during recovery (in-flight flag + per-key guard). | ✅ | `src/CadenceDashboard.recovery.test.jsx` — "reconciles on mount under StrictMode: one lookup, advances exactly once, zero submits" |
| R13 | The plan meter ("Installments sent") | Advances only on a ledger-validated `tesSUCCESS` — never on `tec*`, never on a hash-less rejection, never while unresolved. | ✅ | `src/domain/installment.test.js` — "settleValidated - the only advance in the system" block; `src/CadenceDashboard.dispatch.test.jsx` R5/R6 tests assert `paidCount` unchanged |
| R14 | Secret-shaped keys in persisted state | The storage writer serializes a closed allowlist — `seed`, `private_key`, `mnemonic`, signed-blob-shaped keys (any separator shape) are never persisted, and session-only recovery fields are dropped. | ✅ | `src/storage/planState.test.js` — "scrubs every secret-shaped key name from plans/attempts, across all separator shapes", "never persists plan fields outside the allowlist, even secret-shaped ones" |
| R15 | Malformed or unknown-version storage | Garbage JSON, unknown envelope versions, and hostile field types all resolve to safe defaults at mount — never a throw, never a reinterpretation of unreadable bytes. | ✅ | `src/storage/planState.test.js` — "planState malformed or unknown storage" block ("returns safe defaults for garbage JSON without throwing", "…for an unknown version", "coerces hostile field types into safe defaults instead of throwing") |
| R16 | Secrets in storage or logs | No mnemonic, seed, private key, or signed blob is ever stored or logged. Persisted JSON contains only the allowlisted public fields; error logging goes through the redaction helper. | ✅ | `src/storage/planState.test.js` (R14/R15 rows); `src/domain/installment.test.js` — "carries only the public attempt fields, never plan extras or secrets" |

## On mainnet: what a human exercises before release

Setup: two locally derived, **unfunded** XRPL wallets (employer + employee) are
enough for every row below — the recovery and reconciliation surfaces are
read-only about money until you approve a send. Fund with RLUSD only when a row
requires an actual validated payment (R6/R8/R13 with a real `tesSUCCESS`).

1. **Baseline round-trip (R1–R4, R13).** Connect the payer wallet, create a
   plan, start it. The first payment prompt opens immediately; the history row
   says the plan started and the payment was submitted (never "scheduled" for
   your click). While the first installment is in flight, click **Pay one
   installment** — you should see "…already in flight — wait for the active
   attempt to resolve", and the meter moves exactly once, when the ledger
   validates. Pause the plan within the first 150 ms of starting it; nothing
   should submit afterwards.
2. **Rejected signing (R5).** Start a payment and reject it in the wallet. The
   plan does not advance; a failed row appears with "Wallet confirmation was
   cancelled."; no retry happens without your click.
3. **Ledger failure (R6).** Force a `tec*` (e.g. send to a destination without
   an RLUSD line, unfunded destination). The meter must not move; the failed
   row carries the ledger's result code; the plan does not auto-retry.
4. **Reload mid-flight (R7–R9, R12).** Submit an installment and reload the app
   while the outcome is still unknown (kill the network right after the wallet
   confirms). On reload the card shows "Verifying installment #N with the
   ledger…" and the hash; **Pay one installment** is disabled; "Reconcile now"
   re-runs the lookup. With the network restored, reconciliation classifies the
   attempt (meter advances exactly once for `tesSUCCESS`) — or stays verifying
   forever if the ledger cannot answer. Nothing ever auto-fires during this.
5. **Absence + catch-up (R10–R11).** With an active plan, set the clock past
   two or more windows (or leave the app closed that long), then reload. The
   card counts the missed windows ("N installments missed while the app was
   closed"), each **Approve send** sends exactly one installment through the
   normal wallet flow, and **Skip this window** slides the schedule forward
   without submitting. Paused plans restore paused with no missed-window
   prompt. The count never exceeds the plan's remaining installments.
6. **Storage hygiene (R14–R16).** After a session, inspect
   `localStorage["cadence-plans-v1"]`: only allowlisted public fields (ids,
   addresses, counts, schedule state, attempt hashes/statuses) — no seed,
   mnemonic, private key, or signed blob, no session-only flags.

## Release gate

Run on the release-candidate head before promoting:

```bash
npm install          # first run in a fresh checkout
npm test             # full vitest suite — must be fully green
npm run build        # production build — must succeed
npm run dev          # then, headless browser:
```

Headless smoke (repo verification recipe): load `http://127.0.0.1:5173/`,
confirm the opening screen renders and the title reads "Cadence on XRPL" with
**zero console errors**, and click **Connect XRPL wallet** to confirm the
wallet-selection step advances. Full mainnet wallet flows are out of scope for
the automated gate — external signing cannot run headless.

Observed on 2026-10-09 (headless Chromium):

- **Opening screen:** title "Cadence on XRPL", renders clean — **zero console
  errors, zero page errors**.
- **Connect screen:** advances to wallet selection (Xaman / Xyra detected);
  **zero page errors**. Two `[error]`-level console entries fire from the
  xrpl-connect connector while probing adapter availability — `Failed to check
  Xaman state: WalletError CONNECTION_FAILED — API key is required for Xaman`
  — caught inside the connector, which then surfaces the wallet-selection step
  normally. This is pre-existing web-flow connector behavior on the release
  head (no API key configured for Xaman xApp probing), not a scheduler-recovery
  surface; flagged to the wallet-connection lane.

| Gate | Latest result |
|------|---------------|
| `npm test` | ✅ 188/188 (15 files), 2026-10-09 @ `49c5e6b`; full suite re-run green at the docs head (this file is a docs-only delta on top of the release branch) |
| `npm run build` | ✅ green (pre-existing chunk-size warnings only), re-run green at the docs head |
| Headless smoke — opening screen | ✅ zero console errors, zero page errors |
| Headless smoke — connect screen | ✅ advances to wallet selection, zero page errors; two pre-existing xrpl-connect Xaman-probe console errors noted above (flagged, out of scope) |

## Desktop verification (Electron shell)

The Electron wrapper (`electron/main.cjs`) renders the same UI in a desktop
window: context-isolated (`contextIsolation: true`, `nodeIntegration: false`),
loading the built `dist/index.html?desktop=1` (`npm run desktop`) or the Vite dev
server (`npm run desktop:dev`, wired through `CADENCE_DEV_SERVER_URL` by
`electron/dev-runner.cjs`). It appends renderer console output and load failures
to `cadence-renderer.log` in the Electron userData directory (Linux default:
`~/.config/cadence/`; the "Cadence window created" line prints the exact path).

**System libraries** — Electron needs these on a fresh Linux host (CI runner or
sandbox) before `npm run desktop` or the headless smoke:

```bash
sudo apt-get install -y xvfb libcups2 libnss3 libgbm1 libasound2t64 libgtk-3-0t64 \
  libxtst6 libxss1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libdrm2
```

**Headless desktop smoke** — build, launch under a virtual display, and assert on
the renderer log (window created, no load failure):

```bash
npm run build
LOG="$HOME/.config/cadence/cadence-renderer.log"  # userData default on Linux; the window-created line prints the real path
rm -f "$LOG"
xvfb-run -a npx electron electron/main.cjs --no-sandbox &  # --no-sandbox: no setuid chrome-sandbox helper in sandboxes/CI
APP_PID=$!
sleep 8
grep -q "Cadence window created" "$LOG" || { echo "FAIL: no window"; exit 1; }
if grep -q "load failed" "$LOG"; then echo "FAIL: renderer load error"; exit 1; fi
kill "$APP_PID" 2>/dev/null || true
pkill -f "electron/main.cjs" 2>/dev/null || true
echo "Desktop smoke: PASS"
```

Expected outcomes and boundaries:

| Check | Expected |
|-------|----------|
| Window creation | `Cadence window created. Renderer log path: …` appears in the log within a few seconds of launch |
| Asset load | No `load failed` line — the built-asset run loads `dist/index.html?desktop=1` |
| Renderer output | Renderer console lines land in the same log with level/source/message |
| Screenshots | Best-effort only: headless hosts without a compositor may not capture windows — the log assertions are the evidence; record the limitation rather than faking a pass |
| Full wallet flow | Out of scope headless: connecting and signing need an external XRP wallet (the desktop app imports a mnemonic/family seed at runtime — never in tests, fixtures, or recordings) |

## Evidence index (latest gate)

Captures are attached to the PR 04 task record (not committed to the repo).
All recoverable-state dogfooding used **locally derived unfunded wallets** — no
real funds, no real transactions; the only ledger traffic is read-only
(`account_lines` balance, `tx`-by-hash lookups, all against mainnet
`wss://s1.ripple.com`).

| Label | Covers | Artifact |
|-------|--------|----------|
| smoke-1 | Opening screen: title + clean render, zero console/page errors | `smoke-1-opening.png` |
| smoke-2 | Connect screen: advances to wallet selection (Xaman probe console entries noted above) | `smoke-2-connect-screen.png` |
| tc-1 | R8/R10/R13 — restored plan, recovered banner, meter intact (2 / 7, future window) | `tc-1-recovered-banner.png` |
| tc-2 | R10/R11 — missed-window approval prompt ("1 installment missed…", Approve send / Skip this window) | `tc-2-missed-approval.png` |
| tc-3 | R7/R9 — verifying state: blocked pay button, stored-hash display, Reconcile now → still-unknown persists | `tc-3-verifying-unresolved.png` |
| tc-4 | R8/R12 — recorded reload → reconcile-first restore → missed prompt → Approve send (guarded pre-flight block, prompt re-armed, meter unchanged) → Skip this window (schedule slid exactly one period, history "Missed window skipped") | `tc-4-reload-reconcile-approve.webm` |
