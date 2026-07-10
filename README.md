# Cadence

Real-time RLUSD payroll on the XRP Ledger, built for workers who need income they can receive, verify, and reuse.

Cadence is a payroll-to-reputation prototype for the borderless workforce. It lets an employer treasury stream RLUSD to a worker wallet on XRPL mainnet, sign transactions with Crossmark, and prepare those payments to become portable income proofs for rentals, lending, off-ramping, and other trust-based workflows.

Live app: [https://cadence-green-ten.vercel.app](https://cadence-green-ten.vercel.app)

## Why It Matters

Global workers are often paid through slow rails, fragmented apps, and records that are hard to reuse. Cadence demonstrates a simpler path:

- Employers keep payroll liquidity in an XRPL treasury wallet.
- Workers receive RLUSD in a wallet they control.
- Every payment can be verified on mainnet.
- Income history becomes a foundation for reusable economic reputation.

The current MVP focuses on the first proof point: a real, mainnet-verifiable RLUSD transfer from treasury to worker with the required Cadence source tag.

## Current Demo

The deployed app supports a live treasury-to-worker RLUSD settlement flow.

- Network: XRPL mainnet
- Wallet signing: Crossmark
- Asset: RLUSD
- Source tag: `2606250005`
- Treasury wallet: `rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864`
- Worker wallet: `rBKBuortXq4PYQFH768fzLZXJ1EZWhwbbi`
- RLUSD issuer: `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`
- RLUSD currency code: `524C555344000000000000000000000000000000`

## Demo Script

1. Open [https://cadence-green-ten.vercel.app](https://cadence-green-ten.vercel.app).
2. Connect Crossmark with the treasury wallet.
3. Confirm the worker wallet has an RLUSD trustline.
4. Open the Treasury view.
5. Click `Read wallet balance` to fetch the treasury RLUSD balance from XRPL mainnet.
6. Enter an RLUSD amount.
7. Click `Send once` for a single settlement, or `Start 15s stream` to send the amount every 15 seconds until the treasury balance is depleted.
8. Approve each payment in Crossmark.
9. Verify the submitted transaction on an XRPL explorer and confirm `SourceTag: 2606250005`.

For a quick test transaction, enter `2` RLUSD and use `Send once`.

## What Is Implemented

- React dashboard for worker, treasury, and proof views.
- Crossmark wallet connection.
- XRPL mainnet balance reads over `wss://s1.ripple.com`.
- RLUSD `Payment` transaction construction.
- Treasury-to-worker payment submission through Crossmark.
- Automatic `SourceTag: 2606250005` on settlement transactions.
- Optional 15-second streaming loop that submits repeated payments until available treasury RLUSD runs out.
- Empty-state UI for receipts, proofs, and pay rails instead of fake production data.

## Product Vision

Cadence connects payroll, settlement, and reputation:

- Real-time payroll: Workers can receive earned value faster than traditional payroll cycles.
- Treasury controls: Employers can fund a payroll wallet and settle from available RLUSD balance.
- Portable proofs: Workers can turn verified income history into reusable attestations.
- Privacy-aware verification: Future proof flows can disclose eligibility or income bands without exposing every payroll detail.

## XRPL Fit

XRPL is a strong fit for this use case because it offers fast settlement, low transaction costs, issued assets, and mature wallet tooling. RLUSD gives the payroll flow a stable-value asset, while XRPL transaction metadata gives Cadence a public verification layer for payment history.

Future XRPL-aligned extensions may include escrow-based payroll controls, DID-based worker identity, credential issuance, and privacy-preserving income attestations.

## Architecture

```text
Employer Treasury Wallet
        |
        | Crossmark signs RLUSD Payment
        v
XRPL Mainnet
        |
        | Verifiable transaction with SourceTag 2606250005
        v
Worker Wallet
        |
        | Future proof layer
        v
Portable Income Credentials
```

## Local Development

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

## Build

```bash
npm run build
```

## Vercel Deployment

This repository is configured for Vercel as a Vite single-page app.

- Build command: `npm run build`
- Output directory: `dist`
- Framework: Vite

To deploy, import the GitHub repository into Vercel or push to the connected production branch.

## Dependencies

- React
- Vite
- XRPL.js
- Crossmark SDK
- Recharts

## Current Status And Disclosures

Cadence is a hackathon-ready MVP. The live settlement path uses real XRPL mainnet reads and Crossmark-signed RLUSD payment payloads. The proof, SecretVM, zkVerify, and portable credential panels represent the product direction and presentation layer unless otherwise connected in a later implementation.

Crossmark approval is expected for each transaction. Streaming payments submit one transaction at a time and require wallet confirmation according to the connected wallet's signing behavior.

## Roadmap

- Persist settlement receipts after successful submission.
- Add explorer links for submitted transaction hashes.
- Add worker-side RLUSD balance reads.
- Add proof generation from verified payroll history.
- Add credential export for lender, landlord, and off-ramp workflows.
- Add treasury policy controls for limits, schedules, and worker allowlists.

## License

Prototype for Cadence XRPL payroll experimentation.
