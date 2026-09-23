import { extractedReceiptSchema } from './receiptSchema'
import { runOcrFallback } from './ocrTextParser'
import type { ExtractionResult, ExtractedReceiptData } from '../../types/extraction'

// All 3 required fields (vendor, amount, date) must be present — matches
// the plan's own wording ("if confidence is too low OR extraction is
// incomplete"): a missing required field is incomplete regardless of a
// softer numeric cutoff.
const CONFIDENCE_THRESHOLD = 1.0

export type ValidationStatus = 'valid' | 'needs_review'
export type ExtractionSource = 'vlm' | 'ocr_fallback' | 'none'

export interface ValidatedReceipt {
  status: ValidationStatus
  data: ExtractedReceiptData | null
  source: ExtractionSource
  vlmResult: ExtractionResult
  fallbackResult: ExtractionResult | null
}

// Takes the already-narrowed success:true variant so the schema/confidence
// check stays a plain boolean without fighting TypeScript's discriminated-
// union narrowing at the call site.
function isCompleteAndValid(result: Extract<ExtractionResult, { success: true }>): boolean {
  return result.confidence >= CONFIDENCE_THRESHOLD && extractedReceiptSchema.safeParse(result.data).success
}

/** Validation + OCR Fallback module — the gate between "the AI produced
 * something" and "this is trustworthy enough to build a claim from."
 * Never invents a value: if neither the VLM nor the OCR fallback produces
 * a complete result, whatever partial data exists (with nulls preserved)
 * is returned marked needs_review, for a human to fill in — never guessed. */
export async function validateExtraction(
  vlmResult: ExtractionResult,
  imageBlob: Blob,
): Promise<ValidatedReceipt> {
  if (vlmResult.success && isCompleteAndValid(vlmResult)) {
    return { status: 'valid', data: vlmResult.data, source: 'vlm', vlmResult, fallbackResult: null }
  }

  const fallbackResult = await runOcrFallback(imageBlob)
  if (fallbackResult.success && isCompleteAndValid(fallbackResult)) {
    return {
      status: 'valid',
      data: fallbackResult.data,
      source: 'ocr_fallback',
      vlmResult,
      fallbackResult,
    }
  }

  const bestData = vlmResult.success ? vlmResult.data : fallbackResult.success ? fallbackResult.data : null
  const source: ExtractionSource = vlmResult.success ? 'vlm' : fallbackResult.success ? 'ocr_fallback' : 'none'
  return { status: 'needs_review', data: bestData, source, vlmResult, fallbackResult }
}
