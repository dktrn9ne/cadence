# Cadence

Cadence is a consumer wallet dashboard for RLUSD income verification and scheduled XRP Ledger payments. It connects to the wallet selected in Crossmark, reads that wallet's live XRPL data, and asks Crossmark to sign each real payment.

Cadence does not ask consumers for a seed phrase in the normal flow.

## Run From latest.zip

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
2. Install and unlock Crossmark.
3. Download `latest.zip` from this repo.
4. Unzip it.
5. Open a terminal in the unzipped folder.
6. Install dependencies:

```powershell
npm install
```

7. Start Cadence:

```powershell
npm run desktop:dev
```

If Windows PowerShell blocks `npm`, use:

```powershell
npm.cmd install
npm.cmd run desktop:dev
```

For wallet signing demos, open the local app URL in the browser where Crossmark is installed, usually:

```text
http://127.0.0.1:5173/
```

## Consumer Flow

1. Open Cadence.
2. Click `Connect Crossmark`.
3. Approve the Crossmark connection.
4. Confirm the wallet chip in Cadence matches the active Crossmark wallet.
5. Review the connected wallet's RLUSD balance and income verification dashboard.
6. Add a recipient XRPL address and payment rhythm.
7. Confirm each payment request in Crossmark.

The income verification page reads real `account_tx` ledger data for the connected wallet only. It filters verified income to successful incoming RLUSD payments from the Cadence employer wallet using `SourceTag: 2606250005`.

## Payments And Stream Fee

Cadence can submit real XRPL mainnet transactions.

- Recipient payments are RLUSD `Payment` transactions.
- Every stream/installment includes a separate 1.5% RLUSD stream fee.
- Treasury wallet: `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`
- Fee rate: `1.5%`
- Source tag: `2606250005`

Crossmark may show two confirmation prompts for one installment: one for the recipient payment and one for the treasury fee.

## XRPL Constants

- Network: XRPL mainnet
- WebSocket endpoint: `wss://s1.ripple.com`
- Asset: RLUSD
- RLUSD issuer: `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- RLUSD currency code: `524C555344000000000000000000000000000000`
- Cadence employer/treasury wallet: `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`
- Source tag: `2606250005`

## Safety Notes

- Only connect wallets you control.
- Confirm the recipient address, amount, fee, treasury wallet, RLUSD issuer, and source tag before signing.
- Cadence never stores a consumer seed phrase.
- Support logs redact secret-like fields before export.
- Network fees, account reserves, and trustline behavior are controlled by XRPL mainnet.

## Troubleshooting

If Cadence shows a different wallet than Crossmark, disconnect and reconnect from the opening screen after selecting the correct wallet in Crossmark. Cadence should use the exact public `r...` address returned by Crossmark.

If Crossmark is not detected in the desktop shell, keep the Vite server running and open `http://127.0.0.1:5173/` in the browser where the Crossmark extension is installed.

If the app reports an RLUSD balance of zero, confirm the connected wallet is funded on XRPL mainnet and has an RLUSD trustline to the issuer above.

If a payment does not submit, check Crossmark for a cancelled prompt, insufficient XRP reserve/network fees, a missing RLUSD trustline, or a recipient address typo.

If the desktop app opens to a stale screen, stop old Vite/Electron processes and restart from the current folder.

## Scripts

```bash
npm run dev
npm run desktop:dev
npm run build
npm run desktop
npm run preview
```
