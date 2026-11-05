import { describe, expect, it } from 'vitest'
import { parsePrintedBreakdown, largestNonTenderAmount } from '../../src/modules/validation/receiptBreakdown'
import { checkLineItemConsistency } from '../../src/modules/validation/lineItemConsistency'
import { checkFutureDate, checkPrintedArithmetic, checkReceiptIntegrity } from '../../src/modules/validation/receiptIntegrity'
import { computeFieldConfidence, extractedReceiptSchema } from '../../src/modules/validation/receiptSchema'
import { detectFileKind } from '../../src/modules/validation/fileSignature'
import { normalizeCurrency } from '../../src/utils/currency'
import type { ExtractedReceiptData } from '../../src/types/extraction'

const lines = (text: string) => text.trim().split('\n').map((l) => l.trim())

describe('Printed breakdown parser', () => {
  const receipt = lines(`
    Burger            14.00
    Fries              4.50
    Soda               2.25
    Subtotal          20.75
    Tax 8%             1.66
    Tip                3.00
    TOTAL             25.41
    Cash              30.00
    Change             4.59
  `)

  it('reads subtotal, tax, tip, total and the line items', () => {
    const b = parsePrintedBreakdown(receipt)
    expect(b.total).toBe(25.41)
    expect(b.subtotal).toBe(20.75)
    expect(b.tax).toBe(1.66)
    expect(b.tip).toBe(3)
    expect(b.lineItems).toEqual([
      { description: 'Burger', amount: 14 },
      { description: 'Fries', amount: 4.5 },
      { description: 'Soda', amount: 2.25 },
    ])
  })

  it('never treats cash tendered or change as the total (real bug #23)', () => {
    expect(largestNonTenderAmount(receipt)).toBe(25.41)
  })

  it('ignores a zero "balance due" line on a paid receipt', () => {
    expect(parsePrintedBreakdown(lines('Total 33.79\nBalance due 0.00')).total).toBe(33.79)
  })

  it('reads European and thousands-separated prices', () => {
    expect(parsePrintedBreakdown(lines('Total 1.234,56 EUR')).total).toBe(1234.56)
    expect(parsePrintedBreakdown(lines('Total $1,234.56')).total).toBe(1234.56)
  })

  it('marks tax-included (VAT) receipts', () => {
    expect(parsePrintedBreakdown(lines('Subtotal 10.00\nVAT incl. 1.67\nTotal 10.00')).taxIncluded).toBe(true)
  })
})

describe('Receipt integrity checks', () => {
  const base: ExtractedReceiptData = { vendor: 'X', amount: 25.41, currency: 'USD', date: '2026-03-01', lineItems: [] }

  it('accepts line items that sum to less than the total (untaxed items)', () => {
    expect(checkLineItemConsistency(25, [{ description: 'a', amount: 20 }]).consistent).toBe(true)
  })

  it('flags line items that sum to more than the total', () => {
    const r = checkLineItemConsistency(10, [
      { description: 'a', amount: 8 },
      { description: 'b', amount: 8 },
    ])
    expect(r.consistent).toBe(false)
    expect(r.lineItemSum).toBe(16)
  })

  it('skips the check when there is nothing to compare', () => {
    expect(checkLineItemConsistency(null, [{ description: 'a', amount: 8 }]).consistent).toBe(true)
    expect(checkLineItemConsistency(10, [{ description: 'a', amount: null }]).consistent).toBe(true)
  })

  it('accepts printed arithmetic that adds up', () => {
    const breakdown = parsePrintedBreakdown(lines('Subtotal 20.75\nTax 1.66\nTip 3.00\nTotal 25.41'))
    expect(checkPrintedArithmetic({ ...base, breakdown })).toBeNull()
  })

  it('flags a doctored total', () => {
    const breakdown = parsePrintedBreakdown(lines('Subtotal 20.75\nTax 1.66\nTotal 45.41'))
    expect(checkPrintedArithmetic({ ...base, amount: 45.41, breakdown })).toMatch(/printed total is 45.41/)
  })

  it('does not run the arithmetic check across an unexplained line', () => {
    const breakdown = parsePrintedBreakdown(lines('Subtotal 20.00\nDelivery fee 5.00\nTotal 25.00'))
    expect(breakdown.unexplainedBetween).toBe(true)
    expect(checkPrintedArithmetic({ ...base, breakdown })).toBeNull()
  })

  it('flags a receipt dated in the future, but not an ambiguous day/month', () => {
    const now = new Date('2026-03-05T12:00:00Z')
    expect(checkFutureDate('2026-12-25', now)).toMatch(/after today/)
    expect(checkFutureDate('2026-03-05', now)).toBeNull()
    // 03/04/2026: 4 March (past) or 3 April (future) — never flagged
    expect(checkFutureDate('03/04/2026', now)).toBeNull()
    expect(checkFutureDate('garbage', now)).toBeNull()
  })

  it('combines every reason into one review message', () => {
    const r = checkReceiptIntegrity(
      { ...base, amount: 5, date: '2099-01-01', lineItems: [{ description: 'a', amount: 50 }] },
      new Date('2026-03-05'),
    )
    expect(r.consistent).toBe(false)
    expect(r.reason).toMatch(/Line items sum/)
    expect(r.reason).toMatch(/after today/)
  })
})

describe('Schema, confidence, file type and currency helpers', () => {
  it('scores confidence as the fraction of vendor/amount/date present', () => {
    const d = { vendor: 'A', amount: 1, currency: null, date: null, lineItems: [] }
    expect(computeFieldConfidence(d)).toBeCloseTo(2 / 3)
    expect(computeFieldConfidence({ ...d, vendor: '' })).toBeCloseTo(1 / 3)
  })

  it('rejects model output with the wrong shape', () => {
    expect(extractedReceiptSchema.safeParse({ vendor: 'A', amount: '12.00', currency: null, date: null, lineItems: [] }).success).toBe(false)
    expect(extractedReceiptSchema.safeParse({ vendor: 'A', amount: 12, currency: null, date: null }).success).toBe(false)
  })

  it.each([
    [[0x25, 0x50, 0x44, 0x46, 0x2d], 'pdf'],
    [[0xff, 0xd8, 0xff, 0xe0], 'jpeg'],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], 'png'],
    [[0x4d, 0x5a, 0x90, 0x00], null], // a Windows .exe renamed to .png
    [[0x47, 0x49, 0x46, 0x38], null], // GIF: not supported
  ])('detects the real file type from magic bytes (%#)', async (bytes, kind) => {
    const file = new File([new Uint8Array(bytes)], 'receipt.png', { type: 'image/png' })
    expect(await detectFileKind(file)).toBe(kind)
  })

  it('normalizes currency symbols and never guesses an unknown one', () => {
    expect(normalizeCurrency('$')).toBe('USD')
    expect(normalizeCurrency('₹')).toBe('INR')
    expect(normalizeCurrency(' eur ')).toBe('EUR')
    expect(normalizeCurrency('')).toBeNull()
    expect(normalizeCurrency(null)).toBeNull()
    expect(normalizeCurrency('¥')).toBe('¥')
  })
})
