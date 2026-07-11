# Cadence

Cadence is a local desktop prototype for scheduling small RLUSD payments on the XRP Ledger. It unlocks an XRPL wallet from a family seed or mnemonic, reads the wallet's RLUSD balance on XRPL mainnet, and can sign and submit scheduled or manual RLUSD `Payment` transactions from that wallet.

This build is intended for local testing and demo work. It includes payment-plan setup, payment history, diagnostics, and Electron renderer logging.

## Run From latest.zip

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
2. Download `latest.zip` from this repo.
3. Unzip it.
4. Open a terminal in the unzipped folder.
5. Install dependencies:

```powershell
npm install
```

6. Start the desktop app:

```powershell
npm run desktop:dev
```

If Windows PowerShell blocks `npm`, use the command shim directly:

```powershell
npm.cmd install
npm.cmd run desktop:dev
```

The Electron app window will open. The Vite dev server is also available at `http://127.0.0.1:5173/`.

## What This Version Does

- Unlocks an XRPL wallet locally from either an XRPL family seed or mnemonic phrase.
- Reads the unlocked wallet's RLUSD trustline balance from XRPL mainnet.
- Lets you add people with names, roles, emails, destination XRPL addresses, and pay schedules.
- Supports weekly pay or hourly pay converted into a weekly total.
- Splits weekly pay into installments at selectable frequencies: 15 seconds, 30 seconds, 1 minute, 5 minutes, 15 minutes, 1 hour, or 1 day.
- Starts, pauses, and resumes payment plans.
- Sends a manual installment or queues scheduled installments when a plan is active.
- Signs RLUSD payments locally with `xrpl` and submits them through `wss://s1.ripple.com`.
- Adds `SourceTag: 2606250005` to submitted payment transactions.
- Tracks recent payment and setup activity in an in-app history panel.
- Stores up to 500 debug log entries in browser `localStorage`.
- Exports or clears debug logs from the dashboard.
- Writes Electron renderer console messages to a desktop log file.

## Important Safety Notes

This app can sign real XRPL mainnet transactions. Treat it carefully.

- Do not paste a production wallet secret into code or screens you do not trust.
- Use a test-funded wallet for demos whenever possible.
- Check the destination address, RLUSD issuer, amount, and source tag before relying on any payment.
- Network fees and issuer trustline behavior are controlled by XRPL mainnet conditions.
- The app keeps debug logs in local browser storage; avoid putting sensitive secrets into names, roles, or other non-secret fields.

## RLUSD / XRPL Constants

- Network: XRPL mainnet
- WebSocket endpoint: `wss://s1.ripple.com`
- Asset: RLUSD
- RLUSD issuer: `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- RLUSD currency code: `524C555344000000000000000000000000000000`
- Source tag: `2606250005`

## Demo Flow

1. Launch the desktop app with `npm run desktop:dev`.
2. Click through the intro screen.
3. Choose the wallet phrase type:
   - `XRPL family seed` for a seed that usually starts with `s`.
   - `Mnemonic seed phrase` for a 12- or 24-word phrase.
4. Enter the wallet phrase to unlock the local signing wallet.
5. Let Cadence read the wallet's RLUSD balance.
6. Add a person with a destination XRPL address.
7. Choose either weekly pay or hourly pay.
8. Pick the installment frequency.
9. Save the payment plan.
10. Start the plan or click the manual payment action.
11. Review the history and diagnostics panels for submitted, blocked, or failed payment events.

## Diagnostics And Logs

The dashboard includes a diagnostics panel that shows recent structured app events. These are stored in `localStorage` under:

```text
cadence-debug-logs-v1
```

Use `Export logs` in the app to download the current debug log JSON.

Electron also records renderer console messages and load failures here on Windows:

```text
C:\Users\<you>\AppData\Roaming\Electron\cadence-renderer.log
```

Common harmless development messages include Vite startup logs, the React DevTools suggestion, and Electron's development Content Security Policy warning.

## Project Structure

```text
.
|-- electron/
|   |-- dev-runner.cjs   # Starts Vite, waits for port 5173, then opens Electron
|   `-- main.cjs         # Electron BrowserWindow and renderer log capture
|-- src/
|   |-- main.jsx         # React entry point
|   `-- StreamPayDashboard.jsx
|-- index.html
|-- package.json
|-- vite.config.js
`-- vercel.json
```

## Scripts

```bash
npm run dev
```

Starts the Vite web app at `http://127.0.0.1:5173/`.

```bash
npm run desktop:dev
```

Starts Vite and opens the Electron desktop shell.

```bash
npm run build
```

Builds the Vite app into `dist/`.

```bash
npm run desktop
```

Builds the app and opens the packaged-style Electron entry using `dist/index.html`.

```bash
npm run preview
```

Previews the production build with Vite.

## Dependencies

- React 19
- Vite 7
- Electron 39
- xrpl
- Recharts
- Crossmark SDK package is installed, but this version's payment flow signs locally with `xrpl`.

## Troubleshooting

If the desktop app opens to a blank or stale screen, another project may already be using port `5173`. Stop the old Vite/Electron process and restart this app from the current folder.

If `npm run desktop:dev` fails on Windows with `spawn EINVAL`, change the Vite spawn in `electron/dev-runner.cjs` to use the Windows shell:

```js
shell: process.platform === "win32",
```

If the app reports an RLUSD balance of zero, confirm the unlocked wallet has an RLUSD trustline to the issuer listed above and that it is funded on XRPL mainnet.

If a payment is blocked, confirm the wallet is unlocked and the person has a destination XRPL address that starts with `r`.

## Deployment

The repository includes `vercel.json` and can build as a Vite single-page app:

- Build command: `npm run build`
- Output directory: `dist`

The Electron desktop shell is for local execution. A hosted web build will not behave exactly like the desktop app if browser wallet/security behavior differs.

## Status

Cadence is a prototype for RLUSD payroll scheduling and diagnostics. It demonstrates local XRPL signing, mainnet RLUSD balance reads, scheduled installment logic, transaction source tagging, and local debug visibility. It is not production payroll software.
