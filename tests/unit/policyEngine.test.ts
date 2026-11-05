import { describe, expect, it } from 'vitest'
import { evaluatePolicy } from '../../src/modules/policy/policyEngine'
import type { ExtractedReceiptData } from '../../src/types/extraction'
import type { PolicyRecord, PolicySettingsRecord } from '../../src/types/records'

const policies: PolicyRecord[] = [
  { policyId: 'p1', category: 'Meals', limitAmount: 75 },
  { policyId: 'p2', category: 'Lodging', limitAmount: 250 },
]
const settings: PolicySettingsRecord = { id: 'default', baseCurrency: 'USD', rates: { EUR: 1.1, inr: 0.012 } }

const data = (amount: number | null, currency: string | null = 'USD'): ExtractedReceiptData => ({
  vendor: 'X',
  amount,
  currency,
  date: '2026-03-01',
  lineItems: [],
})

describe('Policy Engine', () => {
  it('passes an amount within the limit', () => {
    const r = evaluatePolicy(data(50), 'Meals', policies, settings)
    expect(r.status).toBe('PASS')
    expect(r.reasonCode).toBeNull()
  })

  it('passes an amount exactly at the limit', () => {
    expect(evaluatePolicy(data(75), 'Meals', policies, settings).status).toBe('PASS')
  })

  it('flags an amount over the limit with a category reason code', () => {
    const r = evaluatePolicy(data(75.01), 'Meals', policies, settings)
    expect(r.status).toBe('VIOLATION')
    expect(r.reasonCode).toBe('MEALS_LIMIT_EXCEEDED')
  })

  it('converts foreign currency before comparing', () => {
    const r = evaluatePolicy(data(70, 'EUR'), 'Meals', policies, settings)
    expect(r.convertedAmount).toBeCloseTo(77)
    expect(r.status).toBe('VIOLATION')
  })

  it('matches rate keys case-insensitively and accepts currency symbols', () => {
    expect(evaluatePolicy(data(1000, 'INR'), 'Meals', policies, settings).convertedAmount).toBeCloseTo(12)
    expect(evaluatePolicy(data(60, '€'), 'Meals', policies, settings).convertedAmount).toBeCloseTo(66)
    expect(evaluatePolicy(data(20, '$'), 'Meals', policies, settings).status).toBe('PASS')
  })

  it.each([
    [data(null), 'Meals', 'AMOUNT_MISSING'],
    [data(0), 'Meals', 'AMOUNT_INVALID'],
    [data(-50), 'Meals', 'AMOUNT_INVALID'],
    [data(10, null), 'Meals', 'CURRENCY_UNKNOWN'],
    [data(10, 'JPY'), 'Meals', 'CURRENCY_UNSUPPORTED'],
    [data(10), 'Communication', 'NO_POLICY_DEFINED'],
  ] as const)('sends uncertain input to REVIEW, never PASS (%#: %s)', (d, category, code) => {
    const r = evaluatePolicy(d, category, policies, settings)
    expect(r.status).toBe('REVIEW')
    expect(r.reasonCode).toBe(code)
  })

  it.each([Number.NaN, 0, -5])('refuses to pass against a broken stored limit (%s)', (limitAmount) => {
    const r = evaluatePolicy(data(10), 'Meals', [{ policyId: 'p', category: 'Meals', limitAmount }], settings)
    expect(r.status).toBe('REVIEW')
    expect(r.reasonCode).toBe('POLICY_LIMIT_INVALID')
  })

  it('applies the strictest of conflicting limits and says so (audit fix)', () => {
    const two = [...policies, { policyId: 'p3', category: 'meals', limitAmount: 40 }]
    const r = evaluatePolicy(data(50), 'Meals', two, settings)
    expect(r.status).toBe('VIOLATION')
    expect(r.message).toMatch(/2 limits are set for Meals; the strictest applies/)
    expect(evaluatePolicy(data(30), 'Meals', two, settings).status).toBe('PASS')
  })

  it('does not mention a conflict when duplicate rules agree', () => {
    const same = [...policies, { policyId: 'p3', category: 'Meals', limitAmount: 75 }]
    expect(evaluatePolicy(data(50), 'Meals', same, settings).message).not.toMatch(/strictest/)
  })

  it('still refuses to pass when one of several rules is broken', () => {
    const r = evaluatePolicy(data(10), 'Meals', [...policies, { policyId: 'x', category: 'Meals', limitAmount: Number.NaN }], settings)
    expect(r.reasonCode).toBe('POLICY_LIMIT_INVALID')
  })

  it.each([Number.NaN, 0, -1])('treats a broken conversion rate (%s) as unsupported', (rate) => {
    const r = evaluatePolicy(data(10, 'EUR'), 'Meals', policies, { ...settings, rates: { EUR: rate } })
    expect(r.reasonCode).toBe('CURRENCY_UNSUPPORTED')
  })
})
