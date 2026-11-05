import { describe, expect, it } from 'vitest'
import { dateReadings, normalizeReceiptDate, RECEIPT_DATE_PATTERN } from '../../src/utils/receiptDate'

const iso = (raw: string) => dateReadings(raw).map((d) => d.toISOString().slice(0, 10))

describe('Receipt dates (shared by OCR, reconciler, checks and review)', () => {
  it.each([
    ['2026-03-12', ['2026-03-12']],
    ['13/03/2026', ['2026-03-13']], // day first: used to be unreadable
    ['12-03-2026', ['2026-12-03', '2026-03-12']], // ambiguous: both kept (JS alone said December)
    ['12.03.2026', ['2026-12-03', '2026-03-12']],
    ['03/04/26', ['2026-03-04', '2026-04-03']],
    ['12 Mar 2026', ['2026-03-12']],
    ['12-MAR-2026', ['2026-03-12']],
    ['March 12, 2026', ['2026-03-12']],
    ['Sept 3rd 2026', ['2026-09-03']],
    ['05/05/2026', ['2026-05-05']], // same both ways: one reading
  ])('%s → %j', (raw, expected) => {
    expect(iso(raw)).toEqual(expected)
  })

  it.each(['31/02/2026', '2026-13-01', '00/00/2026', 'yesterday', '', '12/03'])('rejects %j', (raw) => {
    expect(dateReadings(raw)).toEqual([])
  })

  it('stores unambiguous dates as YYYY-MM-DD and keeps ambiguous ones as printed', () => {
    expect(normalizeReceiptDate('13/03/2026')).toBe('2026-03-13')
    expect(normalizeReceiptDate('12 Mar 2026')).toBe('2026-03-12')
    expect(normalizeReceiptDate(' 03/04/2026 ')).toBe('03/04/2026')
    expect(normalizeReceiptDate('garbage')).toBe('garbage')
    expect(normalizeReceiptDate(null)).toBeNull()
  })

  it.each([
    ['Date: 12 Mar 2026 10:42', '12 Mar 2026'],
    ['Invoice date March 12, 2026', 'March 12, 2026'],
    ['Folio 12.03.2026 Room 204', '12.03.2026'],
    ['Paid 2026-03-12', '2026-03-12'],
  ])('finds the date in OCR text: %s', (text, found) => {
    expect(text.match(RECEIPT_DATE_PATTERN)?.[0]).toBe(found)
  })
})
