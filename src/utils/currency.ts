const SYMBOL_TO_CODE: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
}

/** Receipts print "$", the policy engine keys on ISO codes — without this a
 * perfectly read "$28.00" receipt was routed to review as CURRENCY_UNSUPPORTED.
 * Anything not a known symbol is returned trimmed and uppercased, never guessed. */
export function normalizeCurrency(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return SYMBOL_TO_CODE[trimmed] ?? trimmed.toUpperCase()
}
