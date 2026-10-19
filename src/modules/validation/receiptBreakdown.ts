import type { ExtractedLineItem } from '../../types/extraction'

/** What a receipt prints about its own arithmetic, read line by line from
 * OCR text. Every field is null when that line isn't printed (or wasn't
 * read) — nothing here is computed or guessed. */
export interface PrintedBreakdown {
  total: number | null
  subtotal: number | null
  tax: number | null
  /** True when the only tax line says it is already included in the
   * prices (common with VAT/GST), so it must not be added on top. */
  taxIncluded: boolean
  tip: number | null
  discount: number | null
  /** A priced line between "subtotal" and "total" that isn't tax, tip or a
   * discount (e.g. "Delivery fee"). When present, subtotal + tax + tip
   * can't be expected to equal the total, so no arithmetic check is made. */
  unexplainedBetween: boolean
  lineItems: ExtractedLineItem[]
}

type LineKind = 'subtotal' | 'tax' | 'tip' | 'discount' | 'tender' | 'total' | 'item' | 'other'

// A price at the end of a line: "14.00", "$14.00", "14,00 EUR", "1,234.56".
const TRAILING_PRICE = /(-)?\s*(?:USD|EUR|GBP|INR|\$|€|£|₹)?\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})\s*(?:USD|EUR|GBP|INR)?\s*$/i

const SUBTOTAL = /\bsub\s*-?\s*total\b/i
const TAX = /\b(tax|vat|gst|hst|pst|cgst|sgst|igst)\b/i
const TAX_INCLUDED = /\b(incl|included|inclusive)\b/i
const TIP = /\b(tip|gratuity|service\s+charge)\b/i
const DISCOUNT = /\b(discount|coupon|promo|savings)\b/i
// Money handed over or given back is not what the receipt cost. The
// "largest number" rule used to pick these up: a $33.79 meal paid with a
// $50 note was read as a $50 claim.
const CASH_TENDER = /\b(cash|change|tendered|tender)\b/i
const CARD_TENDER = /\b(card|visa|mastercard|amex|debit|credit|payment|auth)\b/i
const TOTAL = /\b(grand\s+total|total|amount\s+due|balance\s+due|balance|amount\s+payable|net\s+payable)\b/i

function parseMoney(raw: string): number {
  // Keep only the last separator as the decimal point: "1,234.56" and
  // "1.234,56" both become 1234.56.
  const lastSep = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','))
  const intPart = raw.slice(0, lastSep).replace(/[.,]/g, '')
  return parseFloat(`${intPart}.${raw.slice(lastSep + 1)}`)
}

function classify(label: string, negative: boolean): LineKind {
  if (SUBTOTAL.test(label)) return 'subtotal'
  if (TAX.test(label)) return 'tax'
  if (TIP.test(label)) return 'tip'
  if (DISCOUNT.test(label) || negative) return 'discount'
  if (CASH_TENDER.test(label)) return 'tender'
  if (TOTAL.test(label)) return 'total'
  if (CARD_TENDER.test(label)) return 'tender'
  // A line item needs a real description, not just a code or a date.
  return (label.match(/[A-Za-z]/g) ?? []).length >= 2 ? 'item' : 'other'
}

export function parsePrintedBreakdown(lines: string[]): PrintedBreakdown {
  const priced = lines
    .map((line, index) => {
      const m = line.match(TRAILING_PRICE)
      if (!m || m.index === undefined) return null
      const label = line.slice(0, m.index).trim()
      const value = parseMoney(m[2])
      if (!Number.isFinite(value)) return null
      return { index, label, value, kind: classify(label, m[1] === '-') }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)

  const first = (kind: LineKind) => priced.find((p) => p.kind === kind)

  // Ignore zero totals: a paid receipt often ends "BALANCE DUE 0.00".
  const totalLine = [...priced].reverse().find((p) => p.kind === 'total' && p.value > 0)
  const subtotalLine = first('subtotal')
  const taxLines = priced.filter((p) => p.kind === 'tax')
  const tipLines = priced.filter((p) => p.kind === 'tip')
  const discountLines = priced.filter((p) => p.kind === 'discount')
  const sum = (ps: { value: number }[]) => (ps.length ? ps.reduce((s, p) => s + Math.abs(p.value), 0) : null)

  // Items are what's listed before the receipt starts totalling up.
  const firstTotalling = priced.find((p) => p.kind === 'subtotal' || p.kind === 'total')
  const lineItems = priced
    .filter((p) => p.kind === 'item' && (!firstTotalling || p.index < firstTotalling.index))
    .map((p) => ({ description: p.label, amount: p.value }))

  // Also true when a line between them has no readable price at all — found
  // live: OCR read "Tax 2.79" as "Tax 279", and without this the missing tax
  // made an honest receipt look like its total didn't add up.
  const pricedIndexes = new Set(priced.map((p) => p.index))
  const unexplainedBetween =
    !!subtotalLine &&
    !!totalLine &&
    lines.some(
      (_, i) =>
        i > subtotalLine.index &&
        i < totalLine.index &&
        (!pricedIndexes.has(i) || priced.find((p) => p.index === i)?.kind === 'item'),
    )

  return {
    total: totalLine?.value ?? null,
    subtotal: subtotalLine?.value ?? null,
    tax: sum(taxLines),
    taxIncluded: taxLines.length > 0 && taxLines.every((t) => TAX_INCLUDED.test(t.label)),
    tip: sum(tipLines),
    discount: sum(discountLines),
    unexplainedBetween,
    lineItems,
  }
}

/** The receipt's largest price that isn't money tendered or returned —
 * the old "largest number is the total" rule, kept only as a fallback for
 * receipts whose total line wasn't read. */
export function largestNonTenderAmount(lines: string[]): number | null {
  const values = lines
    .map((line) => {
      const m = line.match(TRAILING_PRICE)
      if (!m || m.index === undefined) return null
      const label = line.slice(0, m.index)
      if (CASH_TENDER.test(label) || CARD_TENDER.test(label)) return null
      const value = parseMoney(m[2])
      return Number.isFinite(value) ? value : null
    })
    .filter((v): v is number => v !== null)
  return values.length ? Math.max(...values) : null
}
