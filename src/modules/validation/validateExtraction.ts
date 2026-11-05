import { extractedReceiptSchema } from './receiptSchema'
import { runOcrFallback } from './ocrTextParser'
import type { ExtractionResult, ExtractedReceiptData } from '../../types/extraction'
import { normalizeReceiptDate } from '../../utils/receiptDate'

// All 3 required fields (vendor, amount, date) must be present — matches
// the plan's own wording ("if confidence is too low OR extraction is
// incomplete"): a missing required field is incomplete regardless of a
// softer numeric cutoff.
const CONFIDENCE_THRESHOLD = 1.0

export type ValidationStatus = 'valid' | 'needs_review'
export type ExtractionSource = 'ocr' | 'vlm' | 'none'

export interface ValidatedReceipt {
  status: ValidationStatus
  data: ExtractedReceiptData | null
  source: ExtractionSource
  ocrResult: ExtractionResult
  /** null when the VLM was never run — the whole point of the OCR-first
   * order: a receipt OCR already reads with full confidence never pays the
   * multi-minute VLM cost at all. */
  vlmResult: ExtractionResult | null
}

// Both paths return the date as printed; storing it as YYYY-MM-DD when
// only one reading is possible keeps the claim, the export and every later
// check agreeing on what it means (see receiptDate.ts).
function withIsoDate(data: ExtractedReceiptData): ExtractedReceiptData {
  return { ...data, date: normalizeReceiptDate(data.date) }
}

// Takes the already-narrowed success:true variant so the schema/confidence
// check stays a plain boolean without fighting TypeScript's discriminated-
// union narrowing at the call site.
function isCompleteAndValid(result: Extract<ExtractionResult, { success: true }>): boolean {
  return result.confidence >= CONFIDENCE_THRESHOLD && extractedReceiptSchema.safeParse(result.data).success
}

/** Validation + OCR Fallback module — the gate between "extraction produced
 * something" and "this is trustworthy enough to build a claim from."
 *
 * Measured across every real test this session, OCR (Tesseract) reads a
 * clean typed receipt in well under a second and got the exact field
 * (amount) the on-device VLM kept missing, every time — while the VLM alone
 * took 3-6+ minutes per receipt. So OCR now runs FIRST: for the common case
 * (a clean, typed receipt) the slow VLM is never even started. The VLM is
 * only invoked, lazily via `runVlm`, when OCR's own result is incomplete or
 * low-confidence (e.g. a blurry photo or handwriting) — it stays in the
 * pipeline as the fallback for exactly the cases OCR is weak at, just no
 * longer the default path. `runVlm` is a callback rather than an
 * already-awaited result specifically so callers don't have to start the
 * VLM (and pay its cost) before knowing whether OCR already succeeded.
 *
 * Never invents a value: if neither path produces a complete result,
 * whatever partial data exists (with nulls preserved) is returned marked
 * needs_review, for a human to fill in — never guessed. */
export async function validateExtraction(
  imageBlob: Blob,
  runVlm: () => Promise<ExtractionResult>,
): Promise<ValidatedReceipt> {
  const ocrResult = await runOcrFallback(imageBlob)
  if (ocrResult.success && isCompleteAndValid(ocrResult)) {
    return { status: 'valid', data: withIsoDate(ocrResult.data), source: 'ocr', ocrResult, vlmResult: null }
  }

  const vlmResult = await runVlm()
  if (vlmResult.success && isCompleteAndValid(vlmResult)) {
    return { status: 'valid', data: withIsoDate(vlmResult.data), source: 'vlm', ocrResult, vlmResult }
  }

  const rawBest = ocrResult.success ? ocrResult.data : vlmResult.success ? vlmResult.data : null
  const bestData = rawBest && withIsoDate(rawBest)
  const source: ExtractionSource = ocrResult.success ? 'ocr' : vlmResult.success ? 'vlm' : 'none'
  return { status: 'needs_review', data: bestData, source, ocrResult, vlmResult }
}
