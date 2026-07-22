# Cadence

Cadence is a consumer wallet dashboard for RLUSD income verification and scheduled XRP Ledger payments.

The web version uses XRPL Connect so supported XRP wallets can connect to Cadence and sign each real payment. The local desktop version imports a wallet from a BIP39 mnemonic seed phrase or XRPL family seed and signs on this device.

## Run From latest.zip

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
2. Download `latest.zip` from this repo.
3. Unzip it.
4. Open a terminal in the unzipped folder.
5. Install dependencies:

```powershell
npm install
```

6. Start the local desktop app:

```powershell
npm run desktop:dev
```

If Windows PowerShell blocks `npm`, use:

```powershell
npm.cmd install
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

The income verification page reads real `account_tx` ledger data for the connected wallet only. It filters verified income to successful incoming RLUSD payments from the Cadence employer wallet using `SourceTag: 2606250005`.

## Continuous Payments

Cadence can submit real XRPL mainnet transactions.

- Recipient payments are RLUSD `Payment` transactions.
- Each stream/installment submits one RLUSD payment directly to the designated recipient wallet.
- Source tag: `2606250005`

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
