import type { ExtractedReceiptData } from '../../types/extraction'
import { EXPENSE_CATEGORIES, type CategoryResult, type ExpenseCategory, type LineItemCategory } from '../../types/category'

// Deterministic keyword rules, not the VLM — categorizing "Coffee House"
// as Meals doesn't need a multi-minute AI call. Keeps this genuinely fast
// (sub-millisecond) and, per the R&A doc's own reasoning for keeping the
// Policy Engine deterministic, easier to explain/audit than a model guess.
//
// Multi-word phrases here are deliberate, not just longer keywords: they
// let a specific phrase ("uber eats") outrank a generic one-word match
// from a different category ("uber" alone) — found by testing "UBER EATS"
// and seeing it wrongly land in Travel via the bare "uber" keyword.
const CATEGORY_KEYWORDS: Record<Exclude<ExpenseCategory, 'Other'>, string[]> = {
  Travel: [
    'taxi', 'uber', 'lyft', 'cab', 'flight', 'airline', 'airways', 'airport',
    'train', 'railway', 'metro', 'transit', 'parking', 'toll', 'car rental',
    'fuel', 'gas station', 'petrol', 'baggage', 'boarding', 'airfare', 'transport',
    'transportation', 'mileage',
  ],
  Meals: [
    'restaurant', 'cafe', 'coffee', 'bistro', 'diner', 'bakery', 'pizza',
    'burger', 'food', 'kitchen', 'grill', 'eatery', 'catering', 'canteen',
    'uber eats', 'doordash', 'grubhub', 'breakfast', 'lunch', 'dinner', 'meal',
    'latte', 'espresso', 'sandwich', 'room service', 'minibar', 'per diem', 'dining',
  ],
  Lodging: [
    'hotel', 'inn', 'motel', 'resort', 'lodge', 'suites', 'hostel',
    'accommodation', 'guesthouse', 'room', 'night', 'lodging',
  ],
  Communication: [
    'phone', 'mobile', 'telecom', 'internet', 'wifi', 'broadband',
    'wireless', 'cellular', 'data plan', 'telephone', 'telecommunication',
  ],
}

function textToMatch(data: ExtractedReceiptData): string {
  const vendor = data.vendor ?? ''
  const lineItemText = data.lineItems.map((item) => item.description).join(' ')
  return `${vendor} ${lineItemText}`.toLowerCase()
}

// Whole words only (a plural "s"/"es" allowed). Found in the pre-submission
// audit: plain substring matching put "Dinner" in Lodging ("inn"),
// "Cabernet Sauvignon" in Travel ("cab") and "Automobile Club" in
// Communication ("mobile").
const keywordPatterns = new Map<string, RegExp>()
function matchesKeyword(text: string, keyword: string): boolean {
  let pattern = keywordPatterns.get(keyword)
  if (!pattern) {
    pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}(?:s|es)?\\b`)
    keywordPatterns.set(keyword, pattern)
  }
  return pattern.test(text)
}

/** Weight a match by how many words it spans — "uber eats" (2 words)
 * outweighs "uber" (1 word) so a more specific phrase wins over a generic
 * one that happens to be a substring of it. */
function keywordWeight(keyword: string): number {
  return keyword.trim().split(/\s+/).length
}

interface CategoryScore {
  category: Exclude<ExpenseCategory, 'Other'>
  score: number
  matches: string[]
}

/** Category Classifier Agent — maps a validated receipt to a policy
 * category using deterministic keyword matching against vendor name and
 * line-item descriptions. Never guesses past the evidence: no match, or a
 * genuine tie between categories, both return 'Other' rather than picking
 * one arbitrarily — found the tie case by testing "Airport Hotel
 * Restaurant" (equally Travel/Lodging/Meals by keyword count) and seeing
 * it silently pick Travel just because that category was checked first. */
// The vendor says what kind of business it is; line items can mix (a hotel
// bill lists a restaurant charge). Found in the pre-submission audit: once
// line items carried "room" and "dinner", "Boston Harbor Hotel" with a
// "Restaurant dinner" line tied Lodging with Meals and became Other. The
// vendor's keywords now count double, and line items break ties.
const VENDOR_WEIGHT = 2

export function classifyCategory(data: ExtractedReceiptData): CategoryResult {
  const text = textToMatch(data)
  if (!text.trim()) {
    return { category: 'Other', confidence: 0, reason: 'No vendor or line-item text to classify from.' }
  }
  const vendor = (data.vendor ?? '').toLowerCase()
  const items = data.lineItems.map((item) => item.description).join(' ').toLowerCase()
  return pickCategory(
    scoreText(vendor, VENDOR_WEIGHT).map((v, i) => {
      const fromItems = scoreText(items, 1)[i]
      return {
        category: v.category,
        score: v.score + fromItems.score,
        matches: [...new Set([...v.matches, ...fromItems.matches])],
      }
    }),
  )
}

function classifyText(text: string): CategoryResult {
  return pickCategory(scoreText(text, 1))
}

function scoreText(text: string, weight: number): CategoryScore[] {
  return (Object.entries(CATEGORY_KEYWORDS) as [Exclude<ExpenseCategory, 'Other'>, string[]][]).map(
    ([category, keywords]) => {
      const matches = keywords.filter((kw) => matchesKeyword(text, kw))
      return { category, score: matches.reduce((sum, kw) => sum + keywordWeight(kw) * weight, 0), matches }
    },
  )
}

function pickCategory(allScores: CategoryScore[]): CategoryResult {
  const scores = allScores.filter((s) => s.score > 0)

  if (scores.length === 0) {
    return { category: 'Other', confidence: 0, reason: 'No category keyword matched vendor or line items.' }
  }

  const topScore = Math.max(...scores.map((s) => s.score))
  const topCandidates = scores.filter((s) => s.score === topScore)

  if (topCandidates.length > 1) {
    const names = topCandidates.map((c) => c.category).join(', ')
    return {
      category: 'Other',
      confidence: 0,
      reason: `Ambiguous — tied equally between ${names} (matched: ${topCandidates
        .map((c) => c.matches.join('/'))
        .join(' vs. ')}).`,
    }
  }

  const winner = topCandidates[0]
  // Confidence grows with match weight but never claims certainty from a
  // plain substring match — caps below 1.0.
  const confidence = Math.min(0.6 + winner.score * 0.12, 0.95)
  return {
    category: winner.category,
    confidence,
    reason: `Matched keyword(s): ${winner.matches.join(', ')}`,
  }
}

/** Maps each line item to a policy category, as the brief asks, using the
 * same keyword rules on that line's own description. A line whose wording
 * names no category ("Latte" on a café bill, "Croissant") takes the
 * receipt's category rather than being guessed; `inherited` says so. This
 * is what lets a hotel bill with a restaurant charge show the charge as
 * Meals while the bill itself stays Lodging. */
export function classifyLineItems(data: ExtractedReceiptData, receiptCategory: ExpenseCategory): LineItemCategory[] {
  return data.lineItems.map((item) => {
    const own = classifyText(item.description.toLowerCase())
    return own.category === 'Other'
      ? { description: item.description, amount: item.amount, category: receiptCategory, inherited: true }
      : { description: item.description, amount: item.amount, category: own.category, inherited: false }
  })
}

/** The app's category for a name a policy document uses ("Hotel" →
 * Lodging, "Airfare" → Travel), so an imported limit applies to the
 * receipts it was meant for. Null when the name maps to no category. */
export function toExpenseCategory(name: string): ExpenseCategory | null {
  const exact = EXPENSE_CATEGORIES.find((c) => c.toLowerCase() === name.trim().toLowerCase())
  if (exact) return exact
  const guess = classifyText(name.toLowerCase())
  return guess.category === 'Other' ? null : guess.category
}
