import { createWorker } from 'tesseract.js'
import { computeFieldConfidence } from './receiptSchema'
import { normalizeCurrency } from '../../utils/currency'
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

// Found via a real (not synthetic single-line) receipt during the final
// demo pass: a stylized title font the OCR engine failed to read entirely
// caused the vendor-picking heuristic to fall through to the very next
// recognizable line, which was a phone number ("Tel: (555) 019-4472") —
// and because that value is non-null, the confidence score (which only
// checks presence, not plausibility) reported 100% despite being wrong.
// These patterns catch the most common non-vendor metadata lines a real
// receipt prints near the top (phone numbers, labeled fields) so the
// heuristic skips past them the same way it already skips address lines
// that happen to start with a digit.
const PHONE_LIKE_PATTERN = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
const METADATA_LABEL_PATTERN = /^(tel|phone|fax|date|time|server|table|order|receipt|invoice)\b[:#]?/i

// Found live (2026-09-27) testing a second stylized-font case, distinct
// from the phone-number one above: when the real vendor title is a script/
// cursive font Tesseract reads as nothing at all, the search can fall
// through past the excluded metadata lines and land on a genuine line
// item ("Grilled Salmon 24.00") — which matches neither exclusion pattern,
// so it gets accepted as the vendor at a false 100% confidence, same root
// failure as the phone-number case, just a different line shape. A real
// vendor name never ends in a receipt-formatted price; a line item does.
const LINE_ITEM_LIKE_PATTERN = /\d+[.,]\d{2}\s*$/

/** Heuristic field extraction from raw OCR text — deliberately simple
 * regexes, not an LLM. Vendor is a guess (first line that doesn't look
 * like a number, phone, or a labeled metadata field); amount picks the
 * LARGEST dollar-formatted number found, on the assumption a receipt's
 * total is usually its biggest line item. Wrong more often than the VLM
 * would be, by design this only runs when the VLM already failed or was
 * low-confidence, and its own confidence score (gap-fix #4) still gates
 * whether it's trusted or sent to human review either way — though that
 * gate only checks presence, not plausibility, so a wrong-but-non-null
 * guess can still slip through at 100% "confidence"; picking a better
 * candidate line here is the real defense against that. */
// Found live: a photo-quality receipt came back "100% confidence" with the
// year read as 3036 and stray "i" / ". : >" glyphs around the vendor.
// Confidence only checks presence, so an implausible year is treated as
// not-read (null) instead — this routes to the AI fallback or human review
// rather than to a clean draft carrying a wrong date.
function isPlausibleDate(value: string): boolean {
  const year = value.match(/\b(\d{4})\b/)
  if (!year) return true
  const y = Number(year[1])
  return y >= 2000 && y <= new Date().getFullYear() + 1
}

function cleanOcrNoise(value: string): string {
  return value
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9)]+$/, '')
    .replace(/^[a-z]\s+(?=[A-Z])/, '')
    .trim()
}

function parseReceiptText(text: string): ExtractedReceiptData {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // A real vendor name is always near the very top of a receipt. Limiting
  // the search to the first few lines matters: without it, once every
  // early line is correctly excluded as metadata (as happens when the
  // vendor's own title text is missed by OCR entirely — the exact case
  // this fix was found from), the search would otherwise fall through to
  // a line-item description and confidently mislabel it as the vendor,
  // which is a worse failure than admitting there's no usable candidate.
  const VENDOR_SEARCH_WINDOW = 5
  const rawVendor =
    lines
      .slice(0, VENDOR_SEARCH_WINDOW)
      .find(
        (l) =>
          !/^\d/.test(l) &&
          l.length > 2 &&
          !PHONE_LIKE_PATTERN.test(l) &&
          !METADATA_LABEL_PATTERN.test(l) &&
          !LINE_ITEM_LIKE_PATTERN.test(l),
      ) ?? null
  const vendor = rawVendor ? cleanOcrNoise(rawVendor) || null : null

  const amounts = [...text.matchAll(AMOUNT_PATTERN)]
    .map((m) => parseFloat(m[1].replace(',', '.')))
    .filter((n) => !Number.isNaN(n))
  const amount = amounts.length > 0 ? Math.max(...amounts) : null

  const dateMatch = text.match(DATE_PATTERN)
  const date = dateMatch && isPlausibleDate(dateMatch[1]) ? dateMatch[1] : null

  const currencyMatch = text.match(CURRENCY_PATTERN)
  const currency = normalizeCurrency(currencyMatch ? currencyMatch[0] : null)

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
    // Previously only a worker-INITIALIZATION failure self-healed (the
    // .catch() on workerPromise above). A crash during recognize() itself
    // left the same now-corrupted worker cached, so every future call kept
    // retrying the same broken instance — the documented "needs a page
    // reload" limitation. Mirrors the extraction Worker's own crash
    // recovery (terminate + drop the reference + lazily recreate next
    // call) so ANY failure here, not just an init failure, self-heals.
    if (workerPromise) {
      const broken = workerPromise
      workerPromise = null
      broken.then((w) => w.terminate()).catch(() => {})
    }
    return {
      success: false,
      reason: `OCR fallback failed: ${e instanceof Error ? e.message : String(e)}`,
      latencyMs: performance.now() - startedAt,
    }
  }
}
