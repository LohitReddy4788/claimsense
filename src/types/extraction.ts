export interface ExtractedLineItem {
  description: string
  amount: number | null
}

export interface ExtractedReceiptData {
  vendor: string | null
  amount: number | null
  currency: string | null
  date: string | null
  lineItems: ExtractedLineItem[]
}

/** Which compute path actually ran the on-device model — WebGPU when the
 * browser/hardware genuinely support it, WASM otherwise (much slower, per
 * Phase 5's own measurements). Only ever set on a result that came from
 * the VLM path; the OCR fallback has no device to report and leaves this
 * undefined. Surfaced to the UI (Phase 17) so a WASM-fallback user sees
 * *why* extraction is slower than the documented baseline, instead of
 * just watching an unexplained spinner. */
export type VlmDevice = 'webgpu' | 'wasm'

export type ExtractionResult =
  | {
      success: true
      data: ExtractedReceiptData
      /** 0-1 heuristic: fraction of required fields (vendor, amount, date)
       * the model actually populated with a plausible value. Not a true
       * model-reported probability — VLMs at this size don't expose one —
       * but it's what Phase 6's confidence gate needs to decide
       * continue-vs-fallback. Gap-fix #4 (same pattern, different agent). */
      confidence: number
      rawModelOutput: string
      latencyMs: number
      device?: VlmDevice
    }
  | {
      success: false
      reason: string
      rawModelOutput?: string
      latencyMs: number
      device?: VlmDevice
    }
