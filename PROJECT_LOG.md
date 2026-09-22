# ClaimSense — Project State

Read this file first in any new session on this repo. It is the single source of truth for what's done, what's decided, and what's next. Update it at the end of every phase you complete — don't let it go stale.


## What this project is

A local-first, multi-agent expense-claim system. Ingests receipt PDFs/images, extracts structured data with an on-device vision model, reconciles against locally stored travel requests and company policy, builds a claim, routes it through human review, records a tamper-evident audit trail, and exports XLSX — with zero receipt/personal data ever leaving the device.

Source documents (in `~/Downloads`, already read and reconciled into the decisions below):
- `ClaimSense_Scratch_to_Final_Implementation_Guide.docx` — 19-phase build order
- `ClaimSense_Agent_Module_Implementation_Workflow.docx` — agent/module responsibility split
- `ClaimSense_Important_Only_With_16_RnA_Questions.pdf` — tech stack + the 16 viva Q&A
- `project statements ( new set) (2).pdf` — the official problem statement and evaluation criteria (this is the ground truth when the guides disagree with each other)

## Tech stack (decided, don't re-litigate)

React + TypeScript + Vite + Tailwind CSS v4 · Dexie/IndexedDB (structured records) · OPFS (receipt binaries) · pdf.js + Canvas (document prep) · ONNX Runtime Web + WebGPU→WASM (on-device VLM) · Tesseract.js (OCR fallback) · Web Crypto SHA-256 (audit chain) · SheetJS (XLSX export) · XState (**Orchestrator only**, not every agent).

**Explicitly dropped:** Fuse.js — replaced with a plain weighted-score function for travel reconciliation (more explainable, one fewer dependency).

## Decisions that closed real plan gaps (do not silently reopen these)

1. **Duplicate detection** — dedup key is exact-file SHA-256 (reuse the audit hash) OR normalized vendor+date+amount+currency (normalize = lowercase, trim, strip punctuation). A hit on either → `DUPLICATE_SUSPECTED`, forced review, never auto-rejected. Owner: Sheet Populator (Phase 10).
2. **Currency handling** — Company Policy has a base currency + a static, manually-edited local conversion table (no live FX API — would violate zero-network). Currency missing from the table → `CURRENCY_UNSUPPORTED`, forced review. Ambiguous symbols (e.g. "$") are treated as missing, never guessed. Owner: Policy Engine (Phase 9).
3. **Model loading — bundle, don't fetch.** The quantized ONNX model ships as a static asset under `public/models/` in this repo, same-origin, not fetched from any external CDN. This is stronger than "cache after first online fetch" — there's no external network call to explain in the zero-egress writeup, and the offline claim holds from a cold start. Owner: Phase 5 (bundle it) + Phase 18 (verify with devtools network disabled).
4. **Tesseract fallback parser** — `ocrTextParser.ts` in the Validation module must emit a numeric confidence score alongside the extracted fields (fraction of required fields successfully parsed), not just the fields — otherwise it can't plug into the Phase 6 confidence gate. Owner: Phase 6.
5. **Travel reconciliation — employee ID is a mandatory hard filter**, not a weighted signal. (Original design weighted employee alongside date/destination — a real bug: a strong date+destination score could out-vote a wrong employee and link one person's receipt to someone else's trip. Fixed.) Only date proximity + destination are weighted, among that employee's own trips, for the HIGH/MEDIUM/LOW tier. Owner: Phase 8.
6. **File validation** — check actual file magic bytes (real PDF/JPEG/PNG signature), not just the extension, plus a 15MB hard size cap, before the file reaches pdf.js/Canvas. Owner: Phase 3.

## Phase status

Full 20-phase list with goals, effort ratings, and risk flags lives on the tracker artifact (link above) — treat it as canonical, this file is a summary.

| Phase | Status | Notes |
|---|---|---|
| P0 — Project Setup | **Done, verified** | `tsc -b` clean, dev server renders all 5 dashboard sections (Upload Receipts / Policies / Travel Requests / Claims / Audit Logs), sidebar nav tested by actually clicking and reading back page text, zero console errors. Committed: `a10d207`. |
| P1 — Local Storage Module | **Done, verified** | `src/modules/storage/db.ts` (Dexie, 5 stores) + `src/modules/storage/opfs.ts` (file save/read/hash). Wired into a real `UploadReceiptsPanel`. Verified: uploaded a real file through the actual input, record appeared with a real SHA-256 hash, **reloaded the page and the record survived** (the phase's own done-criterion), read the file back from OPFS byte-for-byte and it matched exactly, cleaned up test data after. Committed: `438bd7a`. |
| P2 — Policy + Travel Request Data | **Done, verified** | `PoliciesPanel` (category limits + base-currency/conversion-table settings, gap-fix #2) and `TravelRequestsPanel` (employee/destination/dates/status). Dexie schema bumped to v2 for `policySettings`. Verified: added real records through the UI with actual keystrokes (see note below on a testing-tool false negative), all fields persisted, survived two reloads, cleared afterward. Committed: `e4fb2e1`. |
| P3 — P19 | Not started | See tracker for full detail per phase, including the gap-fix text folded into each goal. Next up: **P3 — Document Ingestion Agent** (magic-byte file validation + 15MB cap, per gap-fix #6). |

### Testing note for whoever picks this up
The browser automation's programmatic `form_input` on a React-controlled text input does **not** reliably trigger React's `onChange` (it sets the DOM value without the event React's synthetic system listens for) — this produced a false "nothing happened" reading during P2 testing. Verified via direct IndexedDB inspection that the underlying action actually succeeded; confirmed the pattern by retrying with real click+type keystrokes, which work correctly every time. **When verifying a form in the browser, prefer simulated keystrokes (click the field, then type) over programmatic value-setting for anything wired to React state.** Date/select inputs via `form_input` were fine in this case — the issue only showed up on plain text inputs.

A second, related gotcha surfaced during the full E2E pass: reading the page **immediately** after a click can outrun the async Dexie query inside the component's `useEffect`/refresh — looked like a real data-loss bug (a policy rule "disappeared" after reload) until a direct IndexedDB query proved the record was there all along, and a re-check a moment later showed it correctly in the UI too. **When verifying persistence, add a short wait (or re-check) after a reload before concluding data is missing** — don't take the very first read as final.

### Full end-to-end pass (production build) — done, see tracker "E2E-1"
Ran `npm run build` (real production build, not dev server) and served the actual `dist/` output on its own port via `vite preview` (added as a second launch config, `claimsense-preview`, port 4173). On that real build: uploaded a receipt, added a policy rule + currency rate, added a travel request, all in one session — reloaded — all four survived together. OPFS file bytes verified byte-for-byte on the production build too. Confirmed `dist/` is correctly gitignored. No real defects found; the two "bugs" that showed up during testing were both testing-tool timing artifacts (see notes above), not app bugs — verified by checking the raw IndexedDB contents directly rather than trusting the first UI read.

## The one open risk (inherent, not a planning gap)

**Phase 5 — on-device VLM extraction.** Quantized browser vision-language models are workable but slow (expect 5–30s/receipt on CPU/WASM) and WebGPU support is uneven across browsers/hardware. This isn't fixable by more planning — it gets resolved by building it and measuring actual latency/accuracy on real hardware. Scope demo receipts to clean, typed text; don't test handwriting or heavy glare/blur.

## Working rule for whoever picks this up

Don't mark a phase done without actually running it — start the dev server, read the rendered page, click through the interaction, check the console, and note what was specifically verified (see the Verification Log section on the tracker artifact for the P0 example). Update this file's Phase status table and the tracker together whenever a phase completes.

## Environment notes

- Windows machine, Git Bash (POSIX paths) available via the Bash tool; PowerShell also available.
- Dev server: `npm run dev` (port 5173).
- Git repo initialized locally (was not one before P0); `node_modules` correctly gitignored by the Vite scaffold's default `.gitignore`.
