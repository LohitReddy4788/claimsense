import type { ExtractionResult, PolicyExtractionResult } from '../../types/extraction'

interface ExtractionRequest {
  requestId: string
  imageBlob: Blob
  task?: 'receipt' | 'policy'
}

interface ExtractionResponse {
  requestId: string
  result: ExtractionResult
}

interface PolicyExtractionResponse {
  requestId: string
  policyResult: PolicyExtractionResult
}

type WorkerResponse = ExtractionResponse | PolicyExtractionResponse

// Phase 16 finding (Error Handling + Retry): nothing here ever handled the
// worker itself dying — a WebGPU context loss, an out-of-memory kill, or
// any other fatal crash. worker.onerror was never set, so a crashed
// worker's pending request would simply never resolve. Worse, because
// requests are now queued (Phase 15's fix), that one stuck request would
// permanently block sendQueue from ever advancing — a single crash would
// silently deadlock EVERY future extraction for the rest of the session,
// with no error, no timeout, no way to recover short of a full page
// reload. Fixed two ways below: a client-side timeout as the guaranteed
// backstop (mirrors the same defense-in-depth pattern already used for
// PDF rendering in processDocument.ts and generation itself inside
// extractionWorker.ts), plus a worker.onerror handler that fails fast and
// replaces the worker instead of waiting out the full timeout when the
// platform does surface a real error event.
const CLIENT_TIMEOUT_MS = 11 * 60 * 1000 // slightly above the worker's own 10-minute internal cap

let worker: Worker | null = null
const pending = new Map<string, (response: WorkerResponse) => void>()

function failAllPending(reason: string): void {
  for (const resolve of pending.values()) {
    resolve({ requestId: '', result: { success: false, reason, latencyMs: 0 } })
  }
  pending.clear()
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/extractionWorker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { requestId } = event.data
      const resolve = pending.get(requestId)
      if (resolve) {
        pending.delete(requestId)
        resolve(event.data)
      }
    }
    worker.onerror = (event) => {
      failAllPending(`Extraction worker crashed: ${event.message || 'unknown error'}`)
      // Don't keep serving requests to a worker that just proved it can
      // crash — the next call gets a fresh instance instead.
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

// Found by deliberately testing 3 simultaneous extraction requests
// (Phase 15's Agent Comms review): the requestId-based response routing
// above is correct in isolation, but the worker only has one thread, and
// the model's generate() call effectively monopolizes it — sending 3
// requests to the worker at once doesn't run them in parallel, it makes
// them CONTEND for the same compute, and all 3 ended up hitting the
// per-call 10-minute timeout that any one of them would have comfortably
// finished within if run alone. A user can reach this today by clicking
// "Extract" on more than one receipt before the first finishes — and now
// also by the policy-PDF-import flow, which sends one request per page.
// Queuing requests here — one in flight at a time — turns "N requests
// that all fail" into "N requests that each succeed, just one after
// another", which is what actually happens to compute time on this
// hardware regardless of how many requests are in flight at once.
let sendQueue: Promise<unknown> = Promise.resolve()

function sendToWorker(imageBlob: Blob, task: 'receipt' | 'policy'): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID()

    // The guaranteed backstop: even if the worker hangs with no error
    // event at all (a true silent stall, not just a crash), this settles
    // the promise anyway — which is what lets sendQueue advance and keeps
    // every later request from being blocked forever by one bad one.
    const timeoutId = setTimeout(() => {
      if (pending.delete(requestId)) {
        const reason = `No response from the extraction worker after ${CLIENT_TIMEOUT_MS / 1000}s (it may have hung or crashed silently).`
        resolve(
          task === 'policy'
            ? { requestId, policyResult: { success: false, reason, latencyMs: CLIENT_TIMEOUT_MS } }
            : { requestId, result: { success: false, reason, latencyMs: CLIENT_TIMEOUT_MS } },
        )
      }
    }, CLIENT_TIMEOUT_MS)

    pending.set(requestId, (response) => {
      clearTimeout(timeoutId)
      resolve(response)
    })
    const request: ExtractionRequest = { requestId, imageBlob, task }
    getWorker().postMessage(request)
  })
}

/** OCR + Information Extraction Agent — runs the on-device VLM on a
 * processed receipt image (Phase 4's output) inside a dedicated Web Worker,
 * so a multi-minute inference call never freezes the UI thread. Returns
 * structured data plus a confidence score; never throws — a parse failure
 * or model error becomes success:false with a reason, so Phase 6's
 * validation gate always has something well-formed to check. Requests are
 * queued and sent to the worker one at a time (see sendQueue above) rather
 * than fired concurrently. */
export function extractReceipt(imageBlob: Blob): Promise<ExtractionResult> {
  const task = sendQueue.then(() => sendToWorker(imageBlob, 'receipt'))
  sendQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task.then((response) => (response as ExtractionResponse).result)
}

/** Policy-PDF import (Company Policies panel) — reads one rendered page of
 * a policy document and returns candidate spending-limit rules for a
 * human to individually confirm (never saved automatically; see
 * PoliciesPanel). Shares the same worker, queue, and crash/timeout
 * handling as extractReceipt() above — a policy-PDF import and a receipt
 * extraction happening around the same time correctly take turns instead
 * of contending. */
export function extractPolicyPage(imageBlob: Blob): Promise<PolicyExtractionResult> {
  const task = sendQueue.then(() => sendToWorker(imageBlob, 'policy'))
  sendQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task.then((response) => (response as PolicyExtractionResponse).policyResult)
}
