# Audit remediation — October 13, 2026

Scope: repairs to main `7a542a6`, tracked in issue #34. All payment verification uses fixtures and mocked wallet/ledger boundaries. No real transaction was signed or submitted.

## Changes

| Finding | Repair | Regression coverage |
| --- | --- | --- |
| Independent tabs can dispatch stale installments | Web Locks grant one writer per origin/profile. Other tabs cannot persist or dispatch. Ownership is retained until active dispatch/recovery/record writes finish. Electron also takes a single-instance process lock. | `paymentSession.test.js`; production-browser ownership smoke |
| A local submit timeout loses its hash | The public signed hash is persisted before relay; a persistence failure blocks relay. Disconnect cleanup cannot erase a receipt. | `payment-submission.test.js`; dispatcher pre-relay test |
| Hashless unknowns have no recovery input | Recovery form accepts a public wallet-history hash and verifies its payment identity and explicit ledger validation. Unknown answers remain blocked. | `recoverPaymentHash.test.js` |
| An old receipt can count another installment | A hash already attached to another installment cannot settle a new one; recovery refuses any already-attached hash. | Dispatcher receipt-reuse test |
| Success status/count can separate across writes | Successful attempt status, paid count, and next schedule are persisted in one plan envelope. Recovery uses the same atomic envelope principle. | Dispatcher atomic-settlement test |
| Floating-point division loses the weekly total | Integer micro-unit accounting allocates the remaining balance using successful receipts and reconciles the final installment. Missing legacy receipt evidence blocks continuation; payment terms freeze after attempts start. | `amounts.test.js`, including 40,320-installment regression |
| One receipt produces inflated annual income | Estimates require at least three receipts, seven days, and complete fetched history. The first receipt is a timing baseline, excluded from the rate numerator. | Income-proof sample/history tests |
| Partial income can use the requested amount | Only a positive, finite ledger-delivered RLUSD amount counts, with explicit validation. Reconciliation compares numerically equal amounts and refuses partial-payment flags. | Income-proof and ledger tests |
| Unfunded income read references an undefined payer variable | Empty results use the actual resolved payer. | Source-path correction |
| Record writes can finish out of order | Public snapshots are queued in invocation order; the session remains held during record persistence. Recovery waits for record hydration. | Ordered-write and dashboard recovery tests |
| Dependency audit findings | Electron 41.10.7; Node 22.12+ baseline; unused standalone Crossmark SDK and Recharts removed. The used XRPL Connect Crossmark adapter remains. Patch-package replaced by a narrow version-checked font patch. | Clean install, dependency audit, font patch tests |
| Circular XRPL vendor chunks | Codec and core share a vendor chunk. | Production build; no circular-chunk warning |
| Stale README download | Reproducible `latest.zip` plus SHA-256 inventory. CI compares archived bytes with current source. | `release:check`; deterministic generation and stale-file rejection |

## Verification

- Clean `npm ci`: passed.
- `npm test`: **350 tests passed in 29 files**.
- `npm run build`: passed; circular XRPL chunk warning removed.
- `npm audit`: **zero reported vulnerabilities** in the resolved dependency graph. This does not establish that code bundled inside the wallet SDK has no vulnerabilities.
- `npm run release:check`: archive byte comparison is part of the release gate.
- Production-browser checks passed in CI for same-origin tab ownership and a 390px viewport. A built-Electron opening/session smoke is also part of the updated CI gate. Local execution was blocked: the browser download was empty/truncated in this environment. Electron launch was also blocked by the environment's socket/process restrictions. These checks are not represented as local passes.
- Local runtime: Node 24. CI verifies the supported Node 22 baseline.
- A full real-wallet web/desktop flow remains a human release check. No funds, wallet secrets, or actual signing are used by the automated gate.

## Remaining architectural limits

1. The scheduler runs only while Cadence is open and the device is awake. Web wallets require confirmation. Always-on payroll needs a separately designed execution/authorization service.
2. Web Locks coordinate one origin/profile, and Electron's instance lock coordinates desktop processes. Separate origins, profiles, browsers, devices, and web-versus-desktop sessions do not share a distributed lock.
3. An unknown payment with neither a recoverable hash nor proof of non-submission stays blocked. This release provides verified-hash input, not automatic account-history discovery or a dangerous reset override.
4. Plans with missing prior receipts cannot prove the remaining balance. Review wallet history, pause the old plan, and create a new plan for the reviewed remaining amount.
5. Plans and receipts remain local storage, not a shared employer/employee database. High-frequency plans accumulate substantial receipt state and transaction fees; storage quota failures stop dispatch. A scalable service needs durable server-side accounting and execution ownership.
6. Large bundle warnings remain: the prebundled wallet connector is about 910 KB minified; the unified XRPL runtime is about 570 KB. Grouping removes the circular dependency at the cost of a larger single XRPL chunk. The connector still loads on demand.
7. Income estimates are historical payment extrapolations; they are not proof of employment or a guaranteed future salary.

Payment changes require a human merge under `AGENTS.md`. This branch is prepared for review, not automatically promoted to main or deployed.
