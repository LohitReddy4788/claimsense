import { createWorker } from 'tesseract.js'
import { computeFieldConfidence } from './receiptSchema'
import type { ExtractionResult, ExtractedReceiptData } from '../../types/extraction'

// Bundled locally (public/tesseract/) rather than Tesseract.js's CDN
// defaults — same zero-egress requirement as the VLM (gap-fix #3).
const WORKER_PATH = '/tesseract/worker.min.js'
const CORE_PATH = '/tesseract/core/'
const LANG_PATH = '/tesseract/lang/'
const LSTM_ONLY = 1 // Tesseract OEM.LSTM_ONLY — faster and more accurate than the legacy engine

const AMOUNT_PATTERN = /(?:total|amount|due)?\s*[:\-]?\s*(?:USD|EUR|GBP|INR|\$|€|£|₹)?\s*(\d+[.,]\d{2})\b/gi
const DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4})\b/
const CURRENCY_PATTERN = /\b(USD|EUR|GBP|INR)\b|[$€£₹]/

/** Heuristic field extraction from raw OCR text — deliberately simple
 * regexes, not an LLM. Vendor is a guess (first non-numeric line); amount
 * picks the LARGEST dollar-formatted number found, on the assumption a
 * receipt's total is usually its biggest line item. Wrong more often than
 * the VLM would be, by design this only runs when the VLM already failed
 * or was low-confidence, and its own confidence score (gap-fix #4) still
 * gates whether it's trusted or sent to human review either way. */
function parseReceiptText(text: string): ExtractedReceiptData {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const vendor = lines.find((l) => !/^\d/.test(l) && l.length > 2) ?? null

  const amounts = [...text.matchAll(AMOUNT_PATTERN)]
    .map((m) => parseFloat(m[1].replace(',', '.')))
    .filter((n) => !Number.isNaN(n))
  const amount = amounts.length > 0 ? Math.max(...amounts) : null

  const dateMatch = text.match(DATE_PATTERN)
  const date = dateMatch ? dateMatch[1] : null

  const currencyMatch = text.match(CURRENCY_PATTERN)
  const currency = currencyMatch ? currencyMatch[0] : null

  return { vendor, amount, currency, date, lineItems: [] }
}

let workerPromise: ReturnType<typeof createWorker> | null = null

async function getTesseractWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', LSTM_ONLY, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      cacheMethod: 'none', // avoid IndexedDB caching quirks; the file is already same-origin and small
    })
    // If initialization fails (e.g. a transient load error), don't keep
    // returning the same broken worker forever — clear the cache so the
    // next call gets a fresh attempt. Found this the hard way: a failed
    // worker left in place produced a confusing unrelated error on the
    // next call instead of a clean retry.
    workerPromise.catch(() => {
      workerPromise = null
    })
  }
  return workerPromise
}

/** OCR fallback (Validation module) — runs when the VLM extraction failed
 * or scored low confidence. Never throws: an OCR failure becomes
 * success:false with a reason, same contract as the VLM path, so callers
 * can treat both paths identically. */
export async function runOcrFallback(imageBlob: Blob): Promise<ExtractionResult> {
  const startedAt = performance.now()
  try {
    const worker = await getTesseractWorker()
    const { data } = await worker.recognize(imageBlob)
    const latencyMs = performance.now() - startedAt
    const parsed = parseReceiptText(data.text)
    return {
      success: true,
      data: parsed,
      confidence: computeFieldConfidence(parsed),
      rawModelOutput: data.text,
      latencyMs,
    }
  } catch (e) {
    return {
      success: false,
      reason: `OCR fallback failed: ${e instanceof Error ? e.message : String(e)}`,
      latencyMs: performance.now() - startedAt,
    }
  }
}
