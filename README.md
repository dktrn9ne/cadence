# Cadence

Cadence is a consumer wallet dashboard for RLUSD income verification and scheduled XRP Ledger payments.

The web version uses XRPL Connect so supported XRP wallets can connect to Cadence and sign each real payment. The local desktop version imports a wallet from a BIP39 mnemonic seed phrase or XRPL family seed and signs on this device.

## Run From latest.zip

1. Install Node.js 22.12 or newer from [nodejs.org](https://nodejs.org/).
2. Download `latest.zip` from this repo.
3. Unzip it.
4. Open a terminal in the unzipped folder.
5. Install dependencies:

```powershell
npm ci
```

6. Start the local desktop app:

```powershell
npm run desktop:dev
```

If Windows PowerShell blocks `npm`, use:

```powershell
npm.cmd ci
npm.cmd run desktop:dev
```

For the web XRPL Connect version, run the Vite server and open the local app URL in a browser with your preferred supported XRP wallet:

```text
http://127.0.0.1:5173/
```

## Consumer Flow

1. Open Cadence.
2. Local desktop: choose mnemonic seed phrase or XRPL family seed and click `Import wallet`.
3. Web: click `Connect XRPL wallet`, choose a supported wallet, and approve the connection.
4. Cadence opens the employer dashboard first for payment management.
5. Use `Employee dashboard` to review the connected wallet balance and recent received RLUSD.
6. From the employee dashboard, click `Income proof` to open the full income verification screen.
7. Add a recipient XRPL address and payment rhythm from the employer dashboard.
8. Local desktop signs each payment with the imported wallet. Web asks the connected XRPL wallet to confirm each payment request.

The income verification page reads real `account_tx` ledger data for the connected wallet only. It counts only explicitly validated incoming RLUSD payments with a positive ledger-delivered amount, the matching payer and recipient, and `SourceTag: 2606250005`. The payer comes from the matching local plan; when no plan resolves, the historical Cadence employer wallet is shown as a labeled demo fallback.

## Continuous Payments

Cadence can submit real XRPL mainnet transactions.

- Recipient payments are RLUSD `Payment` transactions.
- Each stream/installment submits one RLUSD payment directly to the designated recipient wallet.
- Source tag: `2606250005`
- Keep the app open and the device awake: this is an app-driven scheduler, not an always-on payroll service.
- One active payment session is allowed per browser origin/profile. Close the owning tab and refresh another tab to transfer ownership. Browsers without Web Locks cannot submit payments.
- The desktop shell permits one process instance. Separate browsers, profiles, devices, and web/desktop surfaces do not share a distributed lock.
- Each plan pays one weekly total and then stops. Missed windows require individual approval.
- Amounts use integer micro-units. Prior successful receipts determine the remaining balance, and the final installment reconciles exactly to the weekly total.
- Older plans with incomplete prior receipt evidence are blocked until the operator reviews wallet history and creates a new plan for the remaining amount.
- Recipient, payer, amount, and frequency cannot change while a plan is active or after a payment attempt starts. Pause the old plan and create a new plan for changed terms.

The web version asks the connected XRPL wallet to confirm each recipient payment. The local desktop version signs and submits each recipient payment with the imported mnemonic/family seed wallet.

## Web Wallets

Cadence uses XRPL Connect for the web wallet selector. The current web flow includes Xaman, Crossmark, GemWallet, and Xyra adapters on XRPL mainnet.

## XRPL Constants

- Network: XRPL mainnet
- WebSocket endpoint: `wss://s1.ripple.com`
- Asset: RLUSD
- RLUSD issuer: `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- RLUSD currency code: `524C555344000000000000000000000000000000`
- Cadence employer wallet: `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`
- Source tag: `2606250005`
- Keep the app open and the device awake: this is an app-driven scheduler, not an always-on payroll service.
- One active payment session is allowed per browser origin/profile. Close the owning tab and refresh another tab to transfer ownership. Browsers without Web Locks cannot submit payments.
- The desktop shell permits one process instance. Separate browsers, profiles, devices, and web/desktop surfaces do not share a distributed lock.
- Each plan pays one weekly total and then stops. Missed windows require individual approval.
- Amounts use integer micro-units. Prior successful receipts determine the remaining balance, and the final installment reconciles exactly to the weekly total.
- Older plans with incomplete prior receipt evidence are blocked until the operator reviews wallet history and creates a new plan for the remaining amount.
- Recipient, payer, amount, and frequency cannot change while a plan is active or after a payment attempt starts. Pause the old plan and create a new plan for changed terms.

## Safety Notes

- Only connect wallets you control.
- Confirm the recipient address, amount, RLUSD issuer, and source tag before signing.
- The local desktop version uses a mnemonic seed phrase or XRPL family seed to create an in-memory signing wallet.
- Support logs redact secret-like fields before export.
- Network fees, account reserves, and trustline behavior are controlled by XRPL mainnet.

## Troubleshooting

If the local desktop app derives a different wallet than expected, use the optional expected public address field to verify the mnemonic or family seed before continuing.

If Cadence web shows a different wallet than expected, disconnect and reconnect from the opening screen after selecting the correct account in your XRPL wallet. Cadence should use the exact public `r...` address returned by XRPL Connect.

If the app reports an RLUSD balance of zero, confirm the connected wallet is funded on XRPL mainnet and has an RLUSD trustline to the issuer above.

If a payment does not submit, check for insufficient XRP reserve/network fees, a missing RLUSD trustline, a recipient address typo, or a cancelled wallet prompt on the web version.

If the desktop app opens to a stale screen, stop old Vite/Electron processes and restart from the current folder.

## Scripts

```bash
npm run dev
npm run desktop:dev
npm run build
npm run desktop
npm run preview
```

## Recover an Interrupted Payment

An unknown submission remains blocked; Cadence never assumes it failed and never blindly retries it.

- Desktop signing persists the public transaction hash before relaying the signed transaction. A transport timeout can therefore be reconciled by hash.
- If a web wallet or an older session lost the hash, open the plan's recovery form and paste the public 64-character transaction hash from wallet history. Cadence verifies payer, recipient, numeric RLUSD amount, issuer, source tag, and ledger validation before settling the held attempt. A hash already used by another attempt is refused.
- If the ledger cannot confirm the transaction, or there is no hash and no proof that nothing was submitted, the installment stays blocked. This release does not implement transaction-history discovery or an override that resets unknown payments.

Income estimates require at least three confirmed payments spanning seven days of complete fetched history. The first receipt establishes the timing baseline and is excluded from the rate numerator. Estimates describe observed payments; they do not verify employment or guarantee future income.

## Maintain the Download Archive

From a Git checkout with Python 3 installed, run `npm run release:archive` after changing source files. `npm run release:check` compares every archived file byte-for-byte with current source, including a SHA-256 manifest. CI blocks stale archives. The archive excludes dependencies, built assets, and environment files; users install the pinned lockfile and build locally.

## Verification

Run `npm ci`, `npm test`, `npm run build`, and `npm run release:check`. For the production browser smoke, install Chromium with `npx playwright install chromium`, then run `npm run test:browser`. Browser checks exercise ownership and viewport rendering without connecting a wallet or contacting the ledger. `npm run test:desktop` verifies the built Electron opening screen and session ownership without importing a wallet; Linux CI runs it under Xvfb.

The install-time font patch is a small version-checked script, `scripts/patch-sdk-fonts.mjs`; upgrading the pinned wallet connector requires reviewing that script. Crossmark remains supported by XRPL Connect's adapter; the unused standalone SDK has been removed.
