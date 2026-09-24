import { RawImage, type Tensor } from '@huggingface/transformers'
import { getVlm } from '../modules/ai/vlmRuntime'
import { computeFieldConfidence } from '../modules/validation/receiptSchema'
import type { ExtractionResult, ExtractedReceiptData } from '../types/extraction'

// Zero-egress enforcement, worker-side (Phase 18). This worker is where the
// real risk actually lives: it's what loads the ~511MB model and runs
// ONNX Runtime Web, and static analysis of the built bundle turned up a
// real cdn.jsdelivr.net fallback string inside onnxruntime-web's own code
// (used only if its wasmPaths config is left unset). Browser-level network
// monitoring tools were found NOT to capture requests made from inside a
// Worker's own context at all during this same testing pass — a genuine
// blind spot, not evidence of safety — so checking from OUTSIDE the worker
// isn't good enough. This patches fetch from INSIDE the worker itself,
// where it actually runs: same-origin and blob: requests pass through
// unchanged, anything else is blocked outright and reported, turning a
// silent leak into a loud, visible, prevented one instead of trusting that
// nothing ever tries.
const workerOrigin = self.location.origin
const originalFetch = self.fetch.bind(self)
self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
  const resolved = new URL(url, self.location.href).href
  if (!resolved.startsWith(workerOrigin) && !resolved.startsWith('blob:') && !resolved.startsWith('data:')) {
    const message = `Blocked a non-local network request from the extraction worker: ${resolved}`
    console.error(message)
    return Promise.reject(new Error(message))
  }
  return originalFetch(input, init)
}) as typeof fetch

const PROMPT =
  'Read this receipt and output ONLY a JSON object with these exact keys: ' +
  '"vendor" (string), "amount" (number, the total), "currency" (3-letter code or symbol), ' +
  '"date" (string, as printed), "lineItems" (array of {"description": string, "amount": number}). ' +
  'Use null for any field you cannot read. Output nothing except the JSON object.'

// Measured on real hardware (Intel Gen-12 iGPU, WebGPU): generation cost
// scales directly with token count and dominates total latency far more
// than the one-time model load. A receipt's JSON output doesn't need 256
// tokens of room — 128 is enough for vendor/amount/currency/date + a
// handful of line items, and roughly halves generation time.
const MAX_NEW_TOKENS = 128

// Observed real-hardware latency ranged 213-241s across earlier tests, then
// one run during Phase 10 testing ran past 440s with no error and no sign
// of a stall (network idle, worker alive) — real variance, not provably a
// hang, but that gap is exactly the risk a missing timeout leaves open:
// with no cap, the UI would show "Running…" forever if generate() ever did
// truly hang. Set generously above every observed run, not tuned to cut
// off slow-but-legitimate ones.
const GENERATION_TIMEOUT_MS = 600_000 // 10 minutes

class ExtractionTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new ExtractionTimeoutError(`Timed out after ${ms}ms`)), ms),
    ),
  ])
}

function extractJsonBlock(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

function normalizeExtracted(raw: unknown): ExtractedReceiptData {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const lineItemsRaw = Array.isArray(obj.lineItems) ? obj.lineItems : []
  return {
    vendor: typeof obj.vendor === 'string' ? obj.vendor : null,
    amount: typeof obj.amount === 'number' ? obj.amount : null,
    currency: typeof obj.currency === 'string' ? obj.currency : null,
    date: typeof obj.date === 'string' ? obj.date : null,
    lineItems: lineItemsRaw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        description: typeof item.description === 'string' ? item.description : '',
        amount: typeof item.amount === 'number' ? item.amount : null,
      })),
  }
}

async function runExtraction(imageBlob: Blob): Promise<ExtractionResult> {
  const startedAt = performance.now()
  // Captured outside the try block (not just in the success branch) so a
  // failure AFTER the model loaded still reports which device it failed
  // on — that's exactly the case where knowing "this was WASM" explains
  // why it took as long as it did before ultimately timing out.
  let device: 'webgpu' | 'wasm' | undefined
  try {
    const vlm = await getVlm()
    device = vlm.device
    const { processor, model } = vlm
    const image = await RawImage.fromBlob(imageBlob)

    const conversation = [
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: PROMPT }] },
    ]
    const promptText = processor.apply_chat_template(conversation, {
      add_generation_prompt: true,
      tokenize: false,
    }) as string

    const inputs = await processor(promptText, image)
    const generated = await withTimeout(
      model.generate({ ...inputs, max_new_tokens: MAX_NEW_TOKENS }) as Promise<unknown>,
      GENERATION_TIMEOUT_MS,
    )
    // generate() returns a Tensor directly unless return_dict_in_generate is
    // requested (we don't); the ModelOutput branch is a defensive fallback,
    // not the expected runtime path.
    const outputIds = (
      generated && typeof generated === 'object' && 'sequences' in generated
        ? (generated as unknown as { sequences: Tensor }).sequences
        : generated
    ) as Tensor

    const decoded = processor.batch_decode(outputIds, { skip_special_tokens: true })[0] as string
    const assistantMarker = decoded.lastIndexOf('Assistant:')
    const completion = assistantMarker === -1 ? decoded : decoded.slice(assistantMarker + 'Assistant:'.length)

    const latencyMs = performance.now() - startedAt
    const jsonBlock = extractJsonBlock(completion)
    if (!jsonBlock) {
      return { success: false, reason: 'Model output contained no JSON object.', rawModelOutput: completion, latencyMs, device }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonBlock)
    } catch (e) {
      return {
        success: false,
        reason: `Model output was not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        rawModelOutput: completion,
        latencyMs,
        device,
      }
    }

    const data = normalizeExtracted(parsed)
    return { success: true, data, confidence: computeFieldConfidence(data), rawModelOutput: completion, latencyMs, device }
  } catch (e) {
    return {
      success: false,
      reason: `Extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      latencyMs: performance.now() - startedAt,
      device,
    }
  }
}

interface ExtractionRequest {
  requestId: string
  imageBlob: Blob
}

interface ExtractionResponse {
  requestId: string
  result: ExtractionResult
}

self.onmessage = async (event: MessageEvent<ExtractionRequest>) => {
  const { requestId, imageBlob } = event.data
  const result = await runExtraction(imageBlob)
  const response: ExtractionResponse = { requestId, result }
  ;(self as unknown as Worker).postMessage(response)
}
