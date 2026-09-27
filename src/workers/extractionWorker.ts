import { RawImage, type Tensor } from '@huggingface/transformers'
import { getVlm } from '../modules/ai/vlmRuntime'
import { computeFieldConfidence } from '../modules/validation/receiptSchema'
import type {
  ExtractionResult,
  ExtractedReceiptData,
  PolicyExtractionResult,
  PolicyRuleCandidate,
} from '../types/extraction'

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

// The "amount" clause below is deliberately more directive than the other
// fields — Phase 5's own measurement found the model got vendor/date right
// 3/3 times but the total amount right 0/3, the one clearly weak field.
// Giving it explicit anchors (the label words receipts actually use, plus
// a concrete fallback rule) is the documented next lever to pull, per
// PROJECT_LOG.md's own note that this was "worth a future prompt pass."
const RECEIPT_PROMPT =
  'Read this receipt and output ONLY a JSON object with EXACTLY these 5 keys, no others: ' +
  '"vendor" (string, the business name), ' +
  '"amount" (number, the FINAL TOTAL amount charged — look for a line labeled ' +
  '"Total", "Amount Due", "Grand Total", or "Balance Due"; if none is labeled that way, ' +
  'use the largest currency amount printed on the receipt), ' +
  '"currency" (3-letter code or symbol), ' +
  '"date" (string, as printed), "lineItems" (array of {"description": string, "amount": number}). ' +
  'Use null for any field you cannot read. Do not add extra keys or nested objects. ' +
  'Output nothing except that one JSON object, as compactly as possible.'

const POLICY_PROMPT =
  'This is a page from a company expense policy document. Find every spending limit ' +
  'mentioned for an expense category (for example Meals, Travel, Lodging, Communication, ' +
  'Hotel, Airfare). Output ONLY a JSON object with one key "rules": an array of objects, ' +
  'each with "category" (string, the expense category name as written) and "limitAmount" ' +
  '(number, the numeric limit only, no currency symbol). If this page states no spending ' +
  'limits at all, output {"rules": []}. Output nothing except the JSON object.'

// Measured on real hardware (Intel Gen-12 iGPU, WebGPU): generation cost
// scales directly with token count and dominates total latency far more
// than the one-time model load. A receipt's JSON output doesn't need 256
// tokens of room — 128 is enough for vendor/amount/currency/date + a
// handful of line items, and roughly halves generation time.
// Raised from 128 after a live test (2026-09-27) showed the sharpened
// receipt prompt below can make the model verbose enough (e.g. inventing
// an extra unrequested nested object) to run past 128 tokens mid-JSON,
// turning an otherwise-correct answer into a truncated-JSON failure. Per
// Phase 5's own measurement, token count is NOT the dominant cost here
// (halving it 256->128 only cut latency ~10%) — session/load overhead
// dominates — so this buys real headroom against truncation for a small
// latency cost, not a proportional one.
const MAX_NEW_TOKENS = 200

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

// Found live (2026-09-27): the model reliably gets the right VALUE but not
// always the right JSON type or shape for it — despite the prompt asking
// for "amount (number)", a real run returned {"amount": "44.28 USD"}, a
// string with the currency embedded rather than a bare number. The exact
// same class of bug already found and fixed in the policy-PDF-import
// worker path (limitAmount as a quoted string) — this predicted the
// receipt path could hit the same failure, and it did. A strict
// `typeof === 'number'` check would silently discard a correct answer as
// if nothing had been read at all, so this extracts the numeric portion
// from a string value instead of rejecting it outright.
function coerceAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/)
    if (match) {
      const n = parseFloat(match[0])
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

// The same run also omitted the "currency" key entirely — the model had
// folded it into the amount string ("44.28 USD") instead. This recovers
// it from there ONLY as a fallback when the model didn't provide a
// currency field on its own; never overrides a real currency value.
function currencyFromAmountString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/\b(USD|EUR|GBP|INR)\b|[$€£₹]/i)
  return match ? match[0].toUpperCase() : null
}

function normalizeExtracted(raw: unknown): ExtractedReceiptData {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const lineItemsRaw = Array.isArray(obj.lineItems) ? obj.lineItems : []
  return {
    vendor: typeof obj.vendor === 'string' ? obj.vendor : null,
    amount: coerceAmount(obj.amount),
    currency: typeof obj.currency === 'string' ? obj.currency : currencyFromAmountString(obj.amount),
    date: typeof obj.date === 'string' ? obj.date : null,
    lineItems: lineItemsRaw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        description: typeof item.description === 'string' ? item.description : '',
        amount: coerceAmount(item.amount),
      })),
  }
}

type VlmPromptOutcome =
  | { ok: true; completion: string; latencyMs: number; device?: 'webgpu' | 'wasm' }
  | { ok: false; reason: string; rawModelOutput?: string; latencyMs: number; device?: 'webgpu' | 'wasm' }

/** Shared model-invocation path for both the receipt and policy-import
 * prompts — everything up through "decode the model's raw text response"
 * is identical between them; only what happens to that text afterward
 * (which JSON shape to expect) differs, handled by each caller. */
async function runVlmPrompt(imageBlob: Blob, prompt: string): Promise<VlmPromptOutcome> {
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

    const conversation = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }]
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

    return { ok: true, completion, latencyMs, device }
  } catch (e) {
    return {
      ok: false,
      reason: `Extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      latencyMs: performance.now() - startedAt,
      device,
    }
  }
}

async function runExtraction(imageBlob: Blob): Promise<ExtractionResult> {
  const outcome = await runVlmPrompt(imageBlob, RECEIPT_PROMPT)
  if (!outcome.ok) {
    return { success: false, reason: outcome.reason, rawModelOutput: outcome.rawModelOutput, latencyMs: outcome.latencyMs, device: outcome.device }
  }
  const { completion, latencyMs, device } = outcome
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
}

// The model reliably gets the right VALUE but not always the right JSON
// TYPE for it — observed live testing returned {"limitAmount": "45"} (a
// quoted string) for every rule on a real run, which a strict `typeof
// === 'number'` check would silently discard as if the model had found
// nothing at all. Coercing a numeric-looking string is the same
// leniency Number() already gives receipts' amount field implicitly
// elsewhere; this makes it explicit for the case actually observed here.
function coerceLimitAmount(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return NaN
}

function normalizePolicyCandidates(raw: unknown): PolicyRuleCandidate[] {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rulesRaw = Array.isArray(obj.rules) ? obj.rules : []
  return rulesRaw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      category: typeof r.category === 'string' ? r.category.trim() : '',
      limitAmount: coerceLimitAmount(r.limitAmount),
    }))
    // A candidate a human is asked to confirm must at least have both
    // fields sensibly present — an empty category name or a non-numeric
    // limit isn't "uncertain, let the human decide," it's not a candidate
    // at all, so it's dropped here rather than shown as a confusing blank
    // suggestion row.
    .filter((r) => r.category.length > 0 && Number.isFinite(r.limitAmount) && r.limitAmount > 0)
}

async function runPolicyExtraction(imageBlob: Blob): Promise<PolicyExtractionResult> {
  const outcome = await runVlmPrompt(imageBlob, POLICY_PROMPT)
  if (!outcome.ok) {
    return { success: false, reason: outcome.reason, rawModelOutput: outcome.rawModelOutput, latencyMs: outcome.latencyMs, device: outcome.device }
  }
  const { completion, latencyMs, device } = outcome
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
  return { success: true, candidates: normalizePolicyCandidates(parsed), rawModelOutput: completion, latencyMs, device }
}

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

self.onmessage = async (event: MessageEvent<ExtractionRequest>) => {
  const { requestId, imageBlob, task } = event.data
  if (task === 'policy') {
    const policyResult = await runPolicyExtraction(imageBlob)
    const response: PolicyExtractionResponse = { requestId, policyResult }
    ;(self as unknown as Worker).postMessage(response)
    return
  }
  const result = await runExtraction(imageBlob)
  const response: ExtractionResponse = { requestId, result }
  ;(self as unknown as Worker).postMessage(response)
}
