# Third-party software and data

ClaimSense is built on the open-source projects below. Each is used under its own license; full license texts ship with each package in `node_modules/`, and the copies bundled into this repository carry theirs alongside them.

## Bundled in this repository

| Component | Where | License |
|---|---|---|
| Tesseract.js worker and Tesseract OCR core (WebAssembly) | `public/tesseract/` | Apache-2.0 (see `public/tesseract/LICENSE-tesseract.js.md`, `public/tesseract/core/LICENSE`, `public/tesseract/worker.min.js.LICENSE.txt`) |
| Tesseract English language data (`eng.traineddata`, from tesseract-ocr/tessdata) | `public/tesseract/lang/` | Apache-2.0 |

## Downloaded separately (not committed)

| Component | Where | License |
|---|---|---|
| SmolVLM-500M-Instruct, by Hugging Face (`HuggingFaceTB/SmolVLM-500M-Instruct`), int8 ONNX export | `public/models/smolvlm-500m-instruct/` | Apache-2.0 |

## Libraries (npm dependencies)

| Library | Used for | License |
|---|---|---|
| React, React DOM | User interface | MIT |
| Vite, @vitejs/plugin-react | Build tooling | MIT |
| Tailwind CSS | Styling | MIT |
| lucide-react | Icons | ISC |
| @electric-sql/pglite | PostgreSQL in the browser | Apache-2.0 (includes PostgreSQL, PostgreSQL License) |
| Dexie | One-time import of data stored by earlier versions | Apache-2.0 |
| @huggingface/transformers | Running the on-device vision-language model | Apache-2.0 |
| onnxruntime-web | Model inference (WebGPU / WASM) | MIT |
| tesseract.js | OCR | Apache-2.0 |
| pdfjs-dist (PDF.js) | Rendering PDF receipts | Apache-2.0 |
| SheetJS (xlsx) | XLSX export | Apache-2.0 |
| XState | Pipeline orchestration | MIT |
| Zod | Schema validation | MIT |
| vite-plugin-pwa (Workbox) | Offline app shell | MIT |
| oxlint | Linting | MIT |
| TypeScript | Language | Apache-2.0 |
