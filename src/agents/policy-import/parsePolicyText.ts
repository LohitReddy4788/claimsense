import { toExpenseCategory } from '../category/classifyCategory'
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '../../types/category'
import type { PolicyRateCandidate, PolicyRuleCandidate } from '../../types/extraction'

export interface ParsedPolicyText {
  rules: PolicyRuleCandidate[]
  rates: PolicyRateCandidate[]
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
// "1 EUR = 1.10 USD"
const RATE_EQUALS = new RegExp(String.raw`\b1(?:\.0+)?\s*([A-Z]{3})\s*=\s*` + NUMBER + String.raw`\s*([A-Z]{3})\b`, 'i')
// "EUR to USD: 1.10", "EUR -> USD 1.10", "EUR → USD = 1.10"
const RATE_ARROW = new RegExp(String.raw`\b([A-Z]{3})\s*(?:to|->|→|=>)\s*([A-Z]{3})\b\s*[:=]?\s*` + NUMBER, 'i')

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ''))
}

function parseRate(line: string): PolicyRateCandidate | null {
  const eq = line.match(RATE_EQUALS)
  if (eq) return { currency: eq[1].toUpperCase(), rate: toNumber(eq[2]), toCurrency: eq[3].toUpperCase() }
  const arrow = line.match(RATE_ARROW)
  if (arrow) return { currency: arrow[1].toUpperCase(), rate: toNumber(arrow[3]), toCurrency: arrow[2].toUpperCase() }
  return null
}

// The words around a limit that aren't part of the category's name.
const FILLER = /\b(limit|limits|maximum|max|up to|per|day|night|receipt|claim|trip|usd|eur|gbp|inr|allowance|cap)\b/gi

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]
}

// Found testing a scanned policy: OCR read "Meals" as "Meas" (a thin "l"
// lost). A one-letter slip on the category's own name is accepted; only
// for whole names of 4+ letters, so a short word can't be mistaken.
function nearCategory(label: string): ExpenseCategory | null {
  const word = label.toLowerCase()
  if (word.length < 4 || word.includes(' ')) return null
  const close = EXPENSE_CATEGORIES.filter((c) => c !== 'Other' && editDistance(word, c.toLowerCase()) <= 1)
  return close.length === 1 ? close[0] : null
}

function parseRule(line: string): PolicyRuleCandidate | null {
  const firstNumber = line.search(/[$€£₹]?\s*\d/)
  if (firstNumber <= 0) return null
  const label = line
    .slice(0, firstNumber)
    .replace(/\([^)]*\)/g, ' ')
    .replace(FILLER, ' ')
    .replace(/[^A-Za-z&/ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // A category name is a word or two; a longer phrase is a sentence that
  // happens to contain a number (a title with a year, a paragraph).
  if (!label || label.split(' ').length > 4) return null
  const category = toExpenseCategory(label) ?? nearCategory(label)
  if (!category) return null
  const amount = line.slice(firstNumber).match(new RegExp(NUMBER))
  if (!amount) return null
  const limitAmount = toNumber(amount[1])
  if (!Number.isFinite(limitAmount) || limitAmount <= 0) return null
  return { category, limitAmount, writtenAs: label }
}

/** Reads spending limits and currency rates out of a policy document's
 * text, one line at a time. Deterministic, so a clearly written policy is
 * read exactly; a line it can't place is skipped, never guessed. The last
 * mention of a category or currency wins (a specific rules section usually
 * follows a summary). */
export function parsePolicyText(text: string): ParsedPolicyText {
  const rules = new Map<string, PolicyRuleCandidate>()
  const rates = new Map<string, PolicyRateCandidate>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const rate = parseRate(line)
    if (rate) {
      if (Number.isFinite(rate.rate) && rate.rate > 0 && rate.currency !== rate.toCurrency) rates.set(rate.currency, rate)
      continue
    }
    const rule = parseRule(line)
    if (rule) rules.set(rule.category.toLowerCase(), rule)
  }
  return { rules: [...rules.values()], rates: [...rates.values()] }
}
