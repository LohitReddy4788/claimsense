import type { ExtractedReceiptData } from '../../types/extraction'
import { checkLineItemConsistency } from './lineItemConsistency'

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

/** Every reading of the printed date, since 03/04/2026 is March 4th in the
 * US and 3 April elsewhere. */
function dateReadings(raw: string): Date[] {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return [new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))]
  const parts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (!parts) return []
  const year = parts[3].length === 2 ? 2000 + +parts[3] : +parts[3]
  const a = +parts[1]
  const b = +parts[2]
  const out: Date[] = []
  if (a <= 12 && b <= 31) out.push(new Date(Date.UTC(year, a - 1, b))) // M/D
  if (b <= 12 && a <= 31) out.push(new Date(Date.UTC(year, b - 1, a))) // D/M
  return out
}

/** A receipt can't be dated after the day it's submitted. Flagged only when
 * EVERY possible reading of the date is in the future (with a day's grace
 * for time zones), so an ambiguous day/month order never causes a flag. */
export function checkFutureDate(date: string | null, now: Date): string | null {
  if (!date) return null
  const readings = dateReadings(date.trim())
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
