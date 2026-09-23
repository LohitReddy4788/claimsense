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
    }
  | {
      success: false
      reason: string
      rawModelOutput?: string
      latencyMs: number
    }
