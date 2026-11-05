import { createWorker } from 'tesseract.js'
import { computeFieldConfidence } from './receiptSchema'
import { normalizeCurrency } from '../../utils/currency'
import { parsePrintedBreakdown, largestNonTenderAmount } from './receiptBreakdown'
import type { ExtractionResult, ExtractedReceiptData } from '../../types/extraction'

// Bundled locally (public/tesseract/) rather than Tesseract.js's CDN
// defaults — same zero-egress requirement as the VLM (gap-fix #3).
const WORKER_PATH = '/tesseract/worker.min.js'
const CORE_PATH = '/tesseract/core/'
const LANG_PATH = '/tesseract/lang/'
const LSTM_ONLY = 1 // Tesseract OEM.LSTM_ONLY — faster and more accurate than the legacy engine

const AMOUNT_PATTERN = /(?:total|amount|due)?\s*[:-]?\s*(?:USD|EUR|GBP|INR|\$|€|£|₹)?\s*(\d+[.,]\d{2})\b/gi
const DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}-\d{1,2}-\d{2,4})\b/
// The code can run straight into the price ("INR12.00", found by the test
// suite), so a following digit also ends it.
const CURRENCY_PATTERN = /\b(USD|EUR|GBP|INR)(?=\b|\d)|[$€£₹]/

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
 * like a number, phone, or a labeled metadata field); amount is the
 * printed TOTAL line, falling back to the largest non-cash/change price
 * (see bug #23 below). Wrong more often than the VLM
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

export function parseReceiptText(text: string): ExtractedReceiptData {
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

  // Real bug #23 (found live 2026-10-19): the amount used to be simply the
  // LARGEST price on the receipt, so a $33.79 meal paid with a $50 note was
  // read as a $50.00 claim at 100% confidence. Now: the printed TOTAL line
  // when it was read; else the largest price that isn't cash tendered or
  // change; the old any-price scan only as a last resort.
  const breakdown = parsePrintedBreakdown(lines)
  const amounts = [...text.matchAll(AMOUNT_PATTERN)]
    .map((m) => parseFloat(m[1].replace(',', '.')))
    .filter((n) => !Number.isNaN(n))
  const amount =
    breakdown.total ?? largestNonTenderAmount(lines) ?? (amounts.length > 0 ? Math.max(...amounts) : null)

  const dateMatch = text.match(DATE_PATTERN)
  const date = dateMatch && isPlausibleDate(dateMatch[1]) ? dateMatch[1] : null

  const currencyMatch = text.match(CURRENCY_PATTERN)
  const currency = normalizeCurrency(currencyMatch ? currencyMatch[0] : null)

  // Line items used to always be [] here, so once OCR became the primary
  // path the line-items-vs-total fake-bill check silently never ran for
  // most receipts.
  return { vendor, amount, currency, date, lineItems: breakdown.lineItems, breakdown }
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

// Tilted, soft or low-contrast photos are where Tesseract slips (found live:
// a year read as 3036). Grayscale + contrast stretch + Otsu binarisation on
// an upscaled copy recovers many of these in seconds, so fewer receipts fall
// through to the multi-minute on-device model. Only used as a second attempt.
const MIN_OCR_WIDTH = 1400

async function enhanceForOcr(imageBlob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(imageBlob)
  const scale = bitmap.width < MIN_OCR_WIDTH ? Math.min(3, MIN_OCR_WIDTH / bitmap.width) : 1
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas context available for OCR preprocessing.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const img = ctx.getImageData(0, 0, w, h)
  const px = img.data
  const gray = new Uint8ClampedArray(w * h)
  const hist = new Array<number>(256).fill(0)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const v = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])
    gray[g] = v
    hist[v]++
  }

  // Stretch between the 2nd and 98th percentile so a washed-out photo uses
  // the full range before thresholding.
  const total = w * h
  let acc = 0
  let lo = 0
  let hi = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= total * 0.02) { lo = v; break }
  }
  acc = 0
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc >= total * 0.02) { hi = v; break }
  }
  const range = Math.max(1, hi - lo)
  const stretchedHist = new Array<number>(256).fill(0)
  for (let i = 0; i < gray.length; i++) {
    const s = Math.max(0, Math.min(255, Math.round(((gray[i] - lo) * 255) / range)))
    gray[i] = s
    stretchedHist[s]++
  }

  // Otsu: pick the threshold that best separates ink from paper.
  let sumAll = 0
  for (let v = 0; v < 256; v++) sumAll += v * stretchedHist[v]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let v = 0; v < 256; v++) {
    wB += stretchedHist[v]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += v * stretchedHist[v]
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2
    if (between > best) { best = between; threshold = v }
  }

  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const out = gray[g] > threshold ? 255 : 0
    px[i] = px[i + 1] = px[i + 2] = out
    px[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

// Found live (2026-10-19, offline test): when Tesseract can't load a file it
// needs (here the language data), it throws inside its own message handler
// and createWorker() never settles — the UI sat on "Reading text (OCR)…"
// forever. Same defense-in-depth as processDocument.ts and extractReceipt.ts:
// a hard timeout turns a silent hang into a normal failure that the catch
// below recovers from. Generous bounds — a cold start is ~10-20s, a read ~1s.
const OCR_INIT_TIMEOUT_MS = 45_000
const OCR_RECOGNIZE_TIMEOUT_MS = 60_000

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** OCR fallback (Validation module) — runs when the VLM extraction failed
 * or scored low confidence. Never throws: an OCR failure becomes
 * success:false with a reason, same contract as the VLM path, so callers
 * can treat both paths identically. */
export async function runOcrFallback(imageBlob: Blob): Promise<ExtractionResult> {
  const startedAt = performance.now()
  try {
    const worker = await withTimeout(getTesseractWorker(), OCR_INIT_TIMEOUT_MS, 'OCR engine start')
    const first = await withTimeout(worker.recognize(imageBlob), OCR_RECOGNIZE_TIMEOUT_MS, 'OCR read')
    let text = first.data.text
    let parsed = parseReceiptText(text)

    // Second attempt only when the first read is incomplete; keeps clean
    // receipts on exactly the path they already take. A preprocessing
    // failure never loses the first result.
    if (computeFieldConfidence(parsed) < 1) {
      try {
        const enhanced = await enhanceForOcr(imageBlob)
        const second = await withTimeout(worker.recognize(enhanced), OCR_RECOGNIZE_TIMEOUT_MS, 'OCR read')
        const secondParsed = parseReceiptText(second.data.text)
        if (computeFieldConfidence(secondParsed) > computeFieldConfidence(parsed)) {
          text = second.data.text
          parsed = secondParsed
        }
      } catch {
        // keep the first attempt
      }
    }

    const latencyMs = performance.now() - startedAt
    return {
      success: true,
      data: parsed,
      confidence: computeFieldConfidence(parsed),
      rawModelOutput: text,
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
