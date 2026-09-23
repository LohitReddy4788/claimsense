import type { ExtractionResult } from '../../types/extraction'

interface ExtractionRequest {
  requestId: string
  imageBlob: Blob
}

interface ExtractionResponse {
  requestId: string
  result: ExtractionResult
}

let worker: Worker | null = null
const pending = new Map<string, (result: ExtractionResult) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/extractionWorker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<ExtractionResponse>) => {
      const { requestId, result } = event.data
      const resolve = pending.get(requestId)
      if (resolve) {
        pending.delete(requestId)
        resolve(result)
      }
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
// "Extract" on more than one receipt before the first finishes. Queuing
// requests here — one in flight at a time — turns "3 requests that all
// fail" into "3 requests that each succeed, just one after another",
// which is what actually happens to compute time on this hardware
// regardless of how many requests are in flight at once.
let sendQueue: Promise<unknown> = Promise.resolve()

function sendToWorker(imageBlob: Blob): Promise<ExtractionResult> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    pending.set(requestId, resolve)
    const request: ExtractionRequest = { requestId, imageBlob }
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
  const task = sendQueue.then(() => sendToWorker(imageBlob))
  sendQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
