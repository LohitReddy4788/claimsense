import type { ExtractedLineItem } from '../../types/extraction'

export interface LineItemConsistencyResult {
  consistent: boolean
  lineItemSum: number | null
  reason: string | null
}

// Real-world receipts routinely have tax, tips, service charges, or
// rounding that isn't itemized as its own line — that's normal, so line
// items summing to LESS than the total is expected, not suspicious. But
// line items summing to MORE than the total has no ordinary explanation:
// nobody pays less than what's itemized. That's the one direction worth
// flagging — a real, deterministic signal that the total may have been
// altered (or misread), without claiming to detect fraud in general.
const TOLERANCE = 1.02 // 2% slack for rounding across currencies/line items

/** One-sided sanity check between a receipt's extracted total and its
 * extracted line items. Deterministic, not AI — same reasoning as the
 * Policy Engine: this kind of check needs to be consistent and
 * explainable, not a model's best guess. Skips entirely (never guesses)
 * when there isn't enough data to compare: a missing total, or no line
 * items with a readable amount. */
export function checkLineItemConsistency(
  amount: number | null,
  lineItems: ExtractedLineItem[],
): LineItemConsistencyResult {
  if (amount === null) {
    return { consistent: true, lineItemSum: null, reason: null }
  }
  const amounts = lineItems.map((item) => item.amount).filter((a): a is number => a !== null)
  if (amounts.length === 0) {
    return { consistent: true, lineItemSum: null, reason: null }
  }

  const lineItemSum = amounts.reduce((sum, a) => sum + a, 0)
  if (lineItemSum > amount * TOLERANCE) {
    return {
      consistent: false,
      lineItemSum,
      reason: `Line items sum to ${lineItemSum.toFixed(2)}, more than the claimed total of ${amount.toFixed(2)}.`,
    }
  }
  return { consistent: true, lineItemSum, reason: null }
}
