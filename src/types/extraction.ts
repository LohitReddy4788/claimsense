import type { PrintedBreakdown } from '../modules/validation/receiptBreakdown'

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
  /** The receipt's own printed subtotal/tax/tip/total lines, when read
   * (OCR path only). Feeds the arithmetic consistency check. */
  breakdown?: PrintedBreakdown
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

/** One candidate spending-limit rule read off a policy document page —
 * "candidate" because nothing here is ever saved automatically. The
 * Policies panel shows each one for a human to individually confirm
 * before it becomes a real rule (see PoliciesPanel's policy-import flow):
 * getting a policy LIMIT wrong is a materially worse failure than getting
 * a receipt field wrong, since every future receipt gets silently
 * checked against it with no downstream review to catch a bad number. */
export interface PolicyRuleCandidate {
  category: string
  limitAmount: number
  /** The document's own name for the category, when it was mapped to one
   * of the app's (e.g. "Hotel" for Lodging). */
  writtenAs?: string
}

/** A currency rate found in a policy document: 1 `currency` = `rate`
 * `toCurrency`. */
export interface PolicyRateCandidate {
  currency: string
  rate: number
  toCurrency: string
}

export type PolicyExtractionResult =
  | {
      success: true
      candidates: PolicyRuleCandidate[]
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
