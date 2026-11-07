import { describe, expect, it } from 'vitest'
import { parsePolicyText } from '../../src/agents/policy-import/parsePolicyText'

const DEMO_POLICY = `ClaimSense Demo Co.
Employee Expense Policy (effective 1 January 2026)
1. Spending limits (per receipt, in USD)
Meals            75 USD
Lodging          250 USD
Travel           200 USD
Communication    100 USD
2. Currency conversion
1 EUR = 1.10 USD
3. Receipts must be submitted within 30 days of the expense.`

describe('parsePolicyText', () => {
  it('reads the demo policy exactly', () => {
    const { rules, rates } = parsePolicyText(DEMO_POLICY)
    expect(rules.map((r) => [r.category, r.limitAmount])).toEqual([
      ['Meals', 75],
      ['Lodging', 250],
      ['Travel', 200],
      ['Communication', 100],
    ])
    expect(rates).toEqual([{ currency: 'EUR', rate: 1.1, toCurrency: 'USD' }])
  })

  it('maps other names to the app categories', () => {
    const { rules } = parsePolicyText('Hotel: up to $250 per night\nMobile phone - 100\nAirfare limit $1,200.00')
    expect(rules.map((r) => [r.category, r.limitAmount])).toEqual([
      ['Lodging', 250],
      ['Communication', 100],
      ['Travel', 1200],
    ])
  })

  it('reads the other rate notations', () => {
    expect(parsePolicyText('EUR to USD: 1.08').rates).toEqual([{ currency: 'EUR', rate: 1.08, toCurrency: 'USD' }])
    expect(parsePolicyText('GBP -> USD 1.27').rates).toEqual([{ currency: 'GBP', rate: 1.27, toCurrency: 'USD' }])
  })

  it('ignores sentences, dates and titles that contain numbers', () => {
    const { rules, rates } = parsePolicyText(
      'Effective 1 January 2026\nReceipts must be submitted within 30 days of the expense.\nSection 2 of 5',
    )
    expect(rules).toEqual([])
    expect(rates).toEqual([])
  })

  it('reads a real OCR of the scanned demo policy', () => {
    // Tesseract's actual output for a scanned copy of the demo policy.
    const ocr = `1. Spending limits (per receipt, in USD)
Category Limit
Meas 75UsD
Lodging 250UsD
Travel 200UsD
Communication 100USD
Rocapts in anotor curroncy aro convortod 0 USD boforo tho mit cack
1EUR =1.10 USD
Actaim over ts category's mits flagged for manager review:`
    const { rules, rates } = parsePolicyText(ocr)
    expect(rules.map((r) => [r.category, r.limitAmount])).toEqual([
      ['Meals', 75],
      ['Lodging', 250],
      ['Travel', 200],
      ['Communication', 100],
    ])
    expect(rates).toEqual([{ currency: 'EUR', rate: 1.1, toCurrency: 'USD' }])
  })

  it('does not stretch a one-letter slip to short or unrelated words', () => {
    expect(parsePolicyText('Meat 40\nTax 5\nParking 20').rules.map((r) => r.category)).toEqual(['Travel'])
  })

  it('keeps the last mention of a category', () => {
    const { rules } = parsePolicyText('Meals 50\nMeals 75')
    expect(rules).toEqual([{ category: 'Meals', limitAmount: 75, writtenAs: 'Meals' }])
  })
})
