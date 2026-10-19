# ClaimSense

AI-powered employee expense claim automation that runs entirely on-device.

ClaimSense turns a folder of receipts into a submitted, human-reviewed
expense claim without any network call for sensitive data. Receipt images
and PDFs are ingested, extracted with an on-device vision-language model
(with a fast OCR pass tried first), classified into spending categories,
reconciled against locally stored travel requests, checked against a
deterministic company policy engine, and built into a claim — all before a
human reviews and approves it. Approved claims export to a real `.xlsx`
spreadsheet.

No receipt, extracted field, or personal data ever leaves the machine it
was processed on. See [`docs/ZERO_EGRESS.md`](docs/ZERO_EGRESS.md) for how
that's actually enforced, not just intended.

## Running it

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. First run downloads nothing sensitive —
the on-device model weights live under `public/models/` and are loaded
same-origin.

```bash
npm run build    # production build (tsc + vite build)
npm run preview  # serve the production build locally
```

## What's in here

- **Upload Receipts** — ingest a PDF/JPEG/PNG, extract vendor/amount/date/
  currency via OCR-first-then-AI-fallback.
- **Policies** — company spending limits per category, a local currency
  conversion table, and PDF-based policy import (suggestions only, never
  auto-saved).
- **Travel Requests** — approved trips a receipt can be reconciled against.
- **Claims** — the built claim, its policy result, and the human review/
  approve step.
- **Audit Logs** — a SHA-256 hash-chained, tamper-evident record of every
  action.
- **Database (SQL)** — read-only SQL over the app's own on-device
  PostgreSQL database.

Works on phones (navigation collapses into a menu below 768px wide) and,
after the first visit, with the network off (installable PWA).

## Docs

- [`docs/architecture.svg`](docs/architecture.svg) — the verified system
  architecture and data flow.
- [`docs/ZERO_EGRESS.md`](docs/ZERO_EGRESS.md) — how zero data egress is
  guaranteed.
- [`PROJECT_LOG.md`](PROJECT_LOG.md) — the full development log: design
  decisions, every phase's verification notes, and real bugs found and
  fixed along the way.

## Stack

React 19 + TypeScript + Vite, Tailwind CSS, PostgreSQL running in the
browser (PGlite, WebAssembly, shared across tabs via a leader-elected
worker) + OPFS for local storage, ONNX Runtime Web (WebGPU/WASM) for on-device inference,
Tesseract.js for OCR, XState for pipeline orchestration, SheetJS for XLSX
export.
