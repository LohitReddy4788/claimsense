# Zero Data Egress — How It's Guaranteed

ClaimSense processes every receipt entirely on the machine it's running on. No receipt image, extracted field, policy rule, or claim record is ever transmitted anywhere. This is enforced in three independent ways, not just assumed:

1. **The AI model runs locally, not against an API.** The vision-language model and OCR engine are bundled with the app itself and loaded from the same origin — there is no call to any cloud inference endpoint (OpenAI, Google, AWS, etc.) at any point. Extraction runs inside a dedicated Web Worker via ONNX Runtime Web (WebGPU, falling back to WASM).

2. **The Worker's own network access is structurally blocked, not just unused.** Standard browser network-monitoring tools don't observe requests made from inside a Worker's own context — a real gap found during testing. To close it, the Worker's `fetch` function is intercepted at the source (`src/workers/extractionWorker.ts`): any request that isn't same-origin (i.e. not the app's own bundled files) is rejected outright and logged as an error, rather than allowed to silently succeed. This turns "we don't call out" from a design intention into an enforced constraint.

3. **All storage is local, and there is no server.** Receipts, extracted data, travel requests, policies, claims, and the audit log all live in the browser's own IndexedDB and OPFS (Origin Private File System) on that one device (`src/modules/storage/`). There is no backend to sync to, because none exists. Currency conversion uses a static, locally-entered rate table rather than a live FX API, for the same reason.

The only point at which data can leave the device is the final export step, where the approved claim is written to a local `.xlsx` file (generated entirely client-side via SheetJS, `src/agents/export/exportClaims.ts`). What happens to that file afterward — whether it's emailed, printed, or left on disk — is a decision made by the person using the app, not an action the software itself performs.

**Verified**: live network monitoring during actual extraction runs (multiple sessions) shows zero non-local requests once the Worker-level enforcement was in place.
