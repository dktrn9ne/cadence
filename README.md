# Cadence

Vercel-ready React prototype for real-time XRPL payroll, Crossmark wallet signing, and portable income proofs.

## Local Development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Vercel Deployment

Import this repository in Vercel. The included `vercel.json` configures:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`

Vercel will install dependencies and serve the dashboard as a single-page app.
