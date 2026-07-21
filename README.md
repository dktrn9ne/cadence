# Cadence

Cadence is a local desktop wallet app for RLUSD income verification and scheduled XRP Ledger payments. It unlocks an XRPL wallet locally, reads the wallet's RLUSD balance and Cadence-tagged income from XRPL mainnet, and can submit recipient payments with a transparent 1.5% stream fee to the Cadence treasury wallet.

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

If Windows PowerShell blocks `npm`, use:

```powershell
npm.cmd install
npm.cmd run desktop:dev
```

## What This Version Does

- Opens to a wallet-first consumer dashboard after unlock.
- Unlocks an XRPL wallet locally from an XRPL family seed or BIP39 mnemonic phrase.
- Verifies the derived wallet against an expected public `r...` address before continuing.
- Reads the connected wallet's RLUSD trustline balance from XRPL mainnet.
- Builds income verification from real `account_tx` ledger data for the connected wallet only.
- Filters verified income to successful incoming RLUSD payments from the Cadence treasury/employer wallet with `SourceTag: 2606250005`.
- Exports income proof CSV and a local support file when needed.
- Lets a payer create recipients and scheduled RLUSD payment plans.
- Sends each recipient installment as RLUSD and sends a separate 1.5% RLUSD stream fee to the Cadence treasury wallet.
- Shows the recipient amount, stream fee, total debit, source tag, and treasury wallet before payment.
- Signs payments locally with `xrpl` and submits through `wss://s1.ripple.com`.

## Stream Fee

- Fee rate: `1.5%`
- Treasury wallet: `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`
- Fee asset: RLUSD
- Fee timing: submitted with each stream/installment as a separate XRPL `Payment`

## Safety Notes

Cadence can sign real XRPL mainnet transactions.

- Only unlock wallets you control.
- Confirm the recipient address, amount, fee, treasury wallet, RLUSD issuer, and source tag before sending.
- The wallet secret is used locally for the session and is redacted from support logs.
- Network fees, account reserves, and trustline behavior are controlled by XRPL mainnet.

## XRPL Constants

- Network: XRPL mainnet
- WebSocket endpoint: `wss://s1.ripple.com`
- Asset: RLUSD
- RLUSD issuer: `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- RLUSD currency code: `524C555344000000000000000000000000000000`
- Source tag: `2606250005`

## Troubleshooting

If the desktop app opens to a stale screen, stop old Vite/Electron processes and restart from the current folder.

If the app reports an RLUSD balance of zero, confirm the connected wallet is funded on XRPL mainnet and has an RLUSD trustline to the issuer above.

If a BIP39 mnemonic fails, check the word spelling/order. If your secret starts with `s`, choose `Auto-detect wallet secret` or `XRPL family seed`.

If a mnemonic opens a different wallet than expected, paste the wallet's public `r...` address into `Expected public wallet address` before connecting. Cadence checks common XRPL BIP39 derivation paths and signing algorithms and will refuse to continue unless it finds that exact address.

## Scripts

```bash
npm run dev
npm run desktop:dev
npm run build
npm run desktop
npm run preview
```
