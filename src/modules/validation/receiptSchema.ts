import { z } from 'zod'

export const lineItemSchema = z.object({
  description: z.string(),
  amount: z.number().nullable(),
})

export const extractedReceiptSchema = z.object({
  vendor: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  date: z.string().nullable(),
  lineItems: z.array(lineItemSchema),
})

const REQUIRED_KEYS = ['vendor', 'amount', 'date'] as const

/** Fraction of required fields (vendor, amount, date) that are non-null —
 * the single confidence formula reused by both extraction paths (VLM and
 * OCR fallback), per gap-fix #4. */
export function computeFieldConfidence(data: z.infer<typeof extractedReceiptSchema>): number {
  const populated = REQUIRED_KEYS.filter((key) => data[key] !== null && data[key] !== '').length
  return populated / REQUIRED_KEYS.length
}
