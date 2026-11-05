import { describe, expect, it } from 'vitest'
import { reconcileTravel } from '../../src/agents/travel/reconcileTravel'
import type { ExtractedReceiptData } from '../../src/types/extraction'
import type { TravelRequestRecord } from '../../src/types/records'

const trip = (over: Partial<TravelRequestRecord> = {}): TravelRequestRecord => ({
  requestId: 'TR-1',
  employeeId: 'EMP001',
  destination: 'Boston',
  startDate: '2026-03-10',
  endDate: '2026-03-14',
  approvalStatus: 'approved',
  ...over,
})

const receipt = (vendor: string, date: string | null): ExtractedReceiptData => ({
  vendor,
  amount: 100,
  currency: 'USD',
  date,
  lineItems: [],
})

describe('Travel-Request Reconciler Agent', () => {
  it('auto-links when date and destination both match', () => {
    const r = reconcileTravel(receipt('Boston Harbor Hotel', '2026-03-12'), 'EMP001', [trip()])
    expect(r.status).toBe('MATCHED')
    expect(r.travelRequestId).toBe('TR-1')
    expect(r.score).toBe(1)
  })

  it('treats the start and end dates as inside the trip', () => {
    expect(reconcileTravel(receipt('Boston Cab', '2026-03-10'), 'EMP001', [trip()]).status).toBe('MATCHED')
    expect(reconcileTravel(receipt('Boston Cab', '2026-03-14'), 'EMP001', [trip()]).status).toBe('MATCHED')
  })

  it('sends a date-only match to review rather than auto-linking', () => {
    const r = reconcileTravel(receipt('Some Diner', '2026-03-12'), 'EMP001', [trip()])
    expect(r.status).toBe('REVIEW')
    expect(r.travelRequestId).toBe('TR-1')
  })

  it('never matches another employee’s trip, however good the score', () => {
    const r = reconcileTravel(receipt('Boston Harbor Hotel', '2026-03-12'), 'EMP002', [trip()])
    expect(r.status).toBe('UNMATCHED')
    expect(r.travelRequestId).toBeNull()
  })

  it('ignores trips that are pending or rejected', () => {
    for (const approvalStatus of ['pending', 'rejected'] as const) {
      const r = reconcileTravel(receipt('Boston Harbor Hotel', '2026-03-12'), 'EMP001', [trip({ approvalStatus })])
      expect(r.status).toBe('UNMATCHED')
    }
  })

  it('does not link a receipt far outside the trip dates', () => {
    const r = reconcileTravel(receipt('Local Cafe', '2026-06-01'), 'EMP001', [trip()])
    expect(r.status).toBe('UNMATCHED')
  })

  it('flags a tie between two equally good trips for a human to pick', () => {
    const r = reconcileTravel(receipt('Boston Hotel', '2026-03-12'), 'EMP001', [
      trip({ requestId: 'TR-1' }),
      trip({ requestId: 'TR-2' }),
    ])
    expect(r.status).toBe('REVIEW')
    expect(r.travelRequestId).toBeNull()
    expect(r.reason).toMatch(/Ambiguous/)
  })

  it('picks the better of two trips', () => {
    const r = reconcileTravel(receipt('Chicago Deep Dish', '2026-04-02'), 'EMP001', [
      trip({ requestId: 'TR-1' }),
      trip({ requestId: 'TR-2', destination: 'Chicago', startDate: '2026-04-01', endDate: '2026-04-03' }),
    ])
    expect(r.status).toBe('MATCHED')
    expect(r.travelRequestId).toBe('TR-2')
  })

  it('skips a trip with malformed dates instead of crashing', () => {
    const r = reconcileTravel(receipt('Boston Hotel', '2026-03-12'), 'EMP001', [
      trip({ startDate: 'not-a-date' }),
    ])
    expect(r.status).toBe('UNMATCHED')
  })

  it('handles a receipt with no date', () => {
    const r = reconcileTravel(receipt('Boston Hotel', null), 'EMP001', [trip()])
    // 0.5 date score * 0.6 + destination 0.4 = 0.7 → review, not auto-link
    expect(r.status).toBe('REVIEW')
  })
})
