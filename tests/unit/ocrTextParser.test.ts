import { describe, expect, it } from 'vitest'
import { parseReceiptText } from '../../src/modules/validation/ocrTextParser'

describe('OCR text parser (OCR + Information Extraction Agent, fast path)', () => {
  it('extracts vendor, amount, date, currency and line items from a typical receipt', () => {
    const d = parseReceiptText(`
      Blue Bottle Coffee
      123 Main St, Boston MA
      Tel: (555) 019-4472
      Date: 2026-03-12
      Latte            $5.50
      Croissant        $4.25
      Subtotal         $9.75
      Tax              $0.78
      Total           $10.53
      Visa            $10.53
    `)
    expect(d.vendor).toBe('Blue Bottle Coffee')
    expect(d.amount).toBe(10.53)
    expect(d.currency).toBe('USD')
    expect(d.date).toBe('2026-03-12')
    expect(d.lineItems.map((i) => i.description)).toEqual(['Latte', 'Croissant'])
  })

  it('skips a phone number when the title font was not read', () => {
    const d = parseReceiptText('Tel: (555) 019-4472\nThe Grill House\nTotal 20.00')
    expect(d.vendor).toBe('The Grill House')
  })

  it('does not take a line item as the vendor', () => {
    const d = parseReceiptText('Grilled Salmon 24.00\nTotal 24.00')
    expect(d.vendor).toBeNull()
  })

  it('treats an implausible year (OCR misread) as no date', () => {
    expect(parseReceiptText('Shop\n3036-03-12\nTotal 5.00').date).toBeNull()
  })

  it('uses the printed total, not the cash handed over', () => {
    expect(parseReceiptText('Diner\nTotal 33.79\nCash 50.00\nChange 16.21').amount).toBe(33.79)
  })

  it('returns nulls, never invented values, for unreadable text', () => {
    const d = parseReceiptText('~~~ ### ~~~')
    expect(d).toMatchObject({ amount: null, date: null, currency: null, lineItems: [] })
  })

  it.each([
    ['€', 'EUR'],
    ['£', 'GBP'],
    ['INR', 'INR'],
    ['USD ', 'USD'],
  ])('reads the %s currency', (symbol, code) => {
    expect(parseReceiptText(`Shop\nTotal ${symbol}12.00`).currency).toBe(code)
  })
})
