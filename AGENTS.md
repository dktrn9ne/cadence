# AGENTS.md — Agent Rules for Cadence

Cadence is a consumer wallet dashboard for RLUSD income verification and scheduled
XRP Ledger payments — a React 19 + Vite 7 web app with an optional Electron 39
desktop shell, pure frontend, contacting XRPL mainnet only when a user connects a
wallet or requests ledger data. Orientation, commands, and the codebase map live in
[.obvious/obvious.md](.obvious/obvious.md); this file is the contract every agent
must honor when changing code.

## Golden rules

1. **Install from the lockfile.** A fresh checkout may run `npm install`; every
   verification gate is a clean install: `npm ci` from the tracked
   `package-lock.json`. Never silently substitute `npm install` for a gate, and
   ignore the stray untracked `bun.lock`.
2. **Static proof is `npm test` and `npm run build`.** There is no lint or
   typecheck. Run both locally before every push; CI (`npm ci` →
   `npm test -- --run` → `npm run build`) is the final gate.
3. **Tests use fixtures and mocks only.** Never a live seed, mnemonic, funded
   wallet, or real transaction. Wallet SDK boundaries are mocked (see
   `tests/app.smoke.test.jsx`); the desktop wallet-import path is never exercised
   in tests.
4. **Never store or log secrets.** No mnemonic, seed, private key, or signed blob
   in code, tests, fixtures, logs, screenshots, or recordings. Persisted state
   keeps only the allowlisted public fields (`src/storage/planState.js`); error
   logging goes through the redaction helper. Demos never connect a real wallet
   and never sign.
5. **Protocol constants are frozen.** Canonical values live in
   `src/domain/xrpl-constants.js` and change only with an explicit human decision:
   RLUSD issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`, employer wallet
   `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`, source tag `2606250005`, RLUSD currency
   hex `524C555344000000000000000000000000000000`, mainnet WS `wss://s1.ripple.com`.
6. **Web and desktop verify separately.** The shared gates are clean install →
   `npm test` → `npm run build`; the per-surface matrix with expected outcomes and
   the desktop system-library install is [docs/QA.md](docs/QA.md). Automated
   verification never signs real transactions — a full wallet flow needs an
   external XRP wallet (Xaman / Crossmark / GemWallet / Xyra) and is an expected
   boundary, not a defect.

## Payment-safety contract

Applies to any change touching payment construction, wallet authorization,
scheduling, persistence, retries, or reconciliation:

- **Installments are a durable state machine:**
  `scheduled → awaiting_signature → submitted → validated_success | validated_failure | unresolved`.
- **Only `validated_success` advances a plan's paid count** — only `tesSUCCESS`
  meta from the ledger, exactly once.
- **`unresolved` exits only via a ledger lookup by transaction hash** — never a
  timer, never a fresh submission. A wallet resolution with no hash (rejected
  signing, failed construction) records a failed attempt and never advances.
- **Deterministic installment IDs:** `${planId}:${sequence}` — derived from plan
  identity and sequence, never generated ad hoc; the per-installment lock is
  keyed on it.
- **One active attempt per installment** across every entry point (scheduler
  tick, manual "Pay one installment", plan-start payment).
- **Wallet changes compare payers.** When the connected public account differs
  from the plan's stored payer, pause and request fresh authorization.
- **Scheduled failures never silently retry.** A failed window unschedules; retry
  is a fresh, user-initiated action.

The full human-checkable matrix (R1–R16) with the automated test that pins each
rule is [docs/QA.md](docs/QA.md).

## Scope and merge discipline

- Changes touching signing, transaction construction, ledger validation, retries,
  scheduling, persistence, or reconciliation require a human merge —
  `.obvious/config.yml` records `merge.requireHumanMerge: true`.
- Docs-only and CI-only PRs merge automatically once checks are green (the PR 07
  release plan's standing exception for non-payment surfaces).
- Defects found during QA are filed as tasks with a repro, a severity, and an
  owner — not silently fixed inside unrelated PRs.

## Environment notes

- Node.js 20, npm 10. No `.env` and no secrets are needed for local dev
  (`.env*` are gitignored).
- If `node_modules` arrives root-owned, Vite's dep optimizer fails with EACCES
  under `node_modules/.vite`: `sudo chown -R $(id -u):$(id -g) node_modules` and
  restart the dev server.
- The Electron desktop shell needs its system libraries on a fresh Linux host —
  see [docs/QA.md](docs/QA.md) for the one-line install and the headless smoke.
