import { describe, expect, it } from 'vitest'
import { classifyCategory } from '../../src/agents/category/classifyCategory'
import type { ExtractedReceiptData } from '../../src/types/extraction'

const receipt = (vendor: string | null, items: string[] = []): ExtractedReceiptData => ({
  vendor,
  amount: 10,
  currency: 'USD',
  date: '2026-03-01',
  lineItems: items.map((description) => ({ description, amount: 1 })),
})

describe('Category Classifier Agent', () => {
  it.each([
    ['Yellow Cab Co', 'Travel'],
    ['Delta Airlines', 'Travel'],
    ['Shell Gas Station', 'Travel'],
    ['Blue Bottle Coffee', 'Meals'],
    ['Joe’s Pizza', 'Meals'],
    ['Marriott Hotel', 'Lodging'],
    ['Holiday Inn Express', 'Lodging'],
    ['Verizon Wireless', 'Communication'],
    ['Comcast Broadband', 'Communication'],
  ])('classifies %s as %s', (vendor, expected) => {
    expect(classifyCategory(receipt(vendor)).category).toBe(expected)
  })

  it('lets a specific phrase beat a generic keyword (Uber Eats is Meals, not Travel)', () => {
    expect(classifyCategory(receipt('UBER EATS')).category).toBe('Meals')
    expect(classifyCategory(receipt('Uber')).category).toBe('Travel')
  })

  it('uses line item text when the vendor name is not informative', () => {
    expect(classifyCategory(receipt('ACME Corp', ['Room night', 'Hotel tax'])).category).toBe('Lodging')
  })

  it('is case-insensitive', () => {
    expect(classifyCategory(receipt('the GRAND hotel')).category).toBe('Lodging')
  })

  it('returns Other for an unknown vendor instead of guessing', () => {
    const r = classifyCategory(receipt('Staples Office Supply'))
    expect(r.category).toBe('Other')
    expect(r.confidence).toBe(0)
  })

  it('returns Other when there is no text at all', () => {
    const r = classifyCategory(receipt(null))
    expect(r.category).toBe('Other')
    expect(r.reason).toMatch(/No vendor/)
  })

  it('returns Other on a genuine tie and names the tied categories', () => {
    const r = classifyCategory(receipt('Airport Hotel Restaurant'))
    expect(r.category).toBe('Other')
    expect(r.reason).toMatch(/Ambiguous/)
  })

  it('keeps confidence between 0.6 and 0.95 for a real match', () => {
    const r = classifyCategory(receipt('Hotel Inn Resort Suites Lodge'))
    expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    expect(r.confidence).toBeLessThanOrEqual(0.95)
  })
})
