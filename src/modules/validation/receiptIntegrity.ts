import type { ExtractedReceiptData } from '../../types/extraction'
import { checkLineItemConsistency } from './lineItemConsistency'
import { dateReadings } from '../../utils/receiptDate'

// Deterministic, explainable signals that a receipt's numbers or date don't
// hold together — each one a reason for a human to look, never a fraud
// verdict. Same spirit as the Policy Engine: rules a reviewer can check by
// hand, not a model's guess. Every check is skipped (never guessed) when the
// receipt doesn't print the values it needs.

/** Cents-level rounding, or half a percent on large totals. */
function tolerance(total: number): number {
  return Math.max(0.02, total * 0.005)
}

/** Printed subtotal + tax + tip − discount should equal the printed total.
 * Two-sided, unlike the line-item check: a total that is too LOW is as
 * unexplained as one that is too high once every adjustment is printed. */
export function checkPrintedArithmetic(data: ExtractedReceiptData): string | null {
  const b = data.breakdown
  if (!b || b.total === null || b.subtotal === null || b.unexplainedBetween) return null
  // Tax-inclusive receipts (VAT/GST "incl.") print a total equal to the
  // subtotal; the tax line is informational, not an add-on.
  if (b.taxIncluded || (b.tax !== null && Math.abs(b.total - b.subtotal) < 0.005)) return null
  const expected = b.subtotal + (b.tax ?? 0) + (b.tip ?? 0) - (b.discount ?? 0)
  if (Math.abs(expected - b.total) <= tolerance(b.total)) return null
  const parts = [`subtotal ${b.subtotal.toFixed(2)}`]
  if (b.tax !== null) parts.push(`tax ${b.tax.toFixed(2)}`)
  if (b.tip !== null) parts.push(`tip ${b.tip.toFixed(2)}`)
  if (b.discount !== null) parts.push(`discount −${b.discount.toFixed(2)}`)
  return `Printed ${parts.join(' + ')} = ${expected.toFixed(2)}, but the printed total is ${b.total.toFixed(2)}.`
}

/** A receipt can't be dated after the day it's submitted. Flagged only when
 * EVERY possible reading of the date is in the future (with a day's grace
 * for time zones), so an ambiguous day/month order never causes a flag. */
export function checkFutureDate(date: string | null, now: Date): string | null {
  if (!date) return null
  const readings = dateReadings(date)
  if (readings.length === 0) return null
  const latestAllowed = now.getTime() + 24 * 60 * 60 * 1000
  if (readings.every((d) => d.getTime() > latestAllowed)) {
    return `Receipt is dated ${date}, which is after today.`
  }
  return null
}

export interface IntegrityResult {
  consistent: boolean
  /** Human-readable reasons, joined, or null when nothing was flagged. */
  reason: string | null
}

export function checkReceiptIntegrity(data: ExtractedReceiptData, now: Date = new Date()): IntegrityResult {
  const reasons = [
    checkLineItemConsistency(data.amount, data.lineItems).reason,
    checkPrintedArithmetic(data),
    checkFutureDate(data.date, now),
  ].filter((r): r is string => r !== null)
  return { consistent: reasons.length === 0, reason: reasons.length ? reasons.join(' ') : null }
}
