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

/** OCR + Information Extraction Agent — runs the on-device VLM on a
 * processed receipt image (Phase 4's output) inside a dedicated Web Worker,
 * so a multi-minute inference call never freezes the UI thread. Returns
 * structured data plus a confidence score; never throws — a parse failure
 * or model error becomes success:false with a reason, so Phase 6's
 * validation gate always has something well-formed to check. */
export function extractReceipt(imageBlob: Blob): Promise<ExtractionResult> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    pending.set(requestId, resolve)
    const request: ExtractionRequest = { requestId, imageBlob }
    getWorker().postMessage(request)
  })
}
