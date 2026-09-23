import type { ExtractedReceiptData } from '../../types/extraction'
import type { TravelRequestRecord } from '../../types/records'
import type { ReconciliationResult } from '../../types/reconciliation'

const MATCH_THRESHOLD = 0.8
const REVIEW_THRESHOLD = 0.4
const MS_PER_DAY = 24 * 60 * 60 * 1000

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** 1.0 inside the trip's date range, decaying to 0 a week outside it, 0.5
 * with no parseable receipt date at all (neither a confirming nor a
 * disqualifying signal — the destination score alone has to carry it). */
function dateScore(receiptDate: Date | null, start: Date, end: Date): number {
  if (!receiptDate) return 0.5
  if (receiptDate >= start && receiptDate <= end) return 1
  const daysOut =
    receiptDate < start
      ? (start.getTime() - receiptDate.getTime()) / MS_PER_DAY
      : (receiptDate.getTime() - end.getTime()) / MS_PER_DAY
  return Math.max(0, 1 - daysOut / 7)
}

function destinationScore(text: string, destination: string): number {
  const dest = destination.trim().toLowerCase()
  if (!dest) return 0
  return text.includes(dest) ? 1 : 0
}

function receiptText(data: ExtractedReceiptData): string {
  const vendor = data.vendor ?? ''
  const lineItemText = data.lineItems.map((i) => i.description).join(' ')
  return `${vendor} ${lineItemText}`.toLowerCase()
}

/** Travel-Request Reconciler Agent — links a receipt to an approved travel
 * request for a specific employee. Employee ID is a MANDATORY HARD FILTER
 * (gap-fix #5), not a weighted signal: a strong date+destination score can
 * never outrank a wrong employee ID, because a wrong-employee trip is
 * never even a candidate. Only date proximity and destination are
 * weighted, and only among that employee's own approved trips. */
export function reconcileTravel(
  data: ExtractedReceiptData,
  employeeId: string,
  travelRequests: TravelRequestRecord[],
): ReconciliationResult {
  const employeeTrips = travelRequests.filter(
    (tr) => tr.employeeId === employeeId && tr.approvalStatus === 'approved',
  )
  if (employeeTrips.length === 0) {
    return {
      status: 'UNMATCHED',
      travelRequestId: null,
      score: 0,
      reason: `No approved travel requests found for employee ${employeeId}.`,
    }
  }

  const text = receiptText(data)
  const receiptDate = parseDate(data.date)

  let best: { trip: TravelRequestRecord; score: number } | null = null
  for (const trip of employeeTrips) {
    const start = parseDate(trip.startDate)
    const end = parseDate(trip.endDate)
    if (!start || !end) continue // malformed stored data — skip, don't crash or guess

    const dScore = dateScore(receiptDate, start, end)
    const destScore = destinationScore(text, trip.destination)
    const score = dScore * 0.6 + destScore * 0.4

    if (!best || score > best.score) best = { trip, score }
  }

  if (!best) {
    return {
      status: 'UNMATCHED',
      travelRequestId: null,
      score: 0,
      reason: `Employee ${employeeId} has approved trips, but none had usable date ranges to compare against.`,
    }
  }

  if (best.score >= MATCH_THRESHOLD) {
    return {
      status: 'MATCHED',
      travelRequestId: best.trip.requestId,
      score: best.score,
      reason: `Date and destination both align with trip to ${best.trip.destination}.`,
    }
  }
  if (best.score >= REVIEW_THRESHOLD) {
    return {
      status: 'REVIEW',
      travelRequestId: best.trip.requestId,
      score: best.score,
      reason: `Partial match with trip to ${best.trip.destination} — date or destination alone, not both.`,
    }
  }
  return {
    status: 'UNMATCHED',
    travelRequestId: null,
    score: best.score,
    reason: `Best candidate (trip to ${best.trip.destination}) scored too low to link automatically.`,
  }
}
