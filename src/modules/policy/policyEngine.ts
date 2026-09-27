import type { ExtractedReceiptData } from '../../types/extraction'
import type { ExpenseCategory } from '../../types/category'
import type { PolicyRecord, PolicySettingsRecord } from '../../types/records'
import type { PolicyCheckResult } from '../../types/policy'

function convertToBase(
  amount: number,
  currency: string,
  settings: PolicySettingsRecord,
): { converted: number; usedRate: number } | null {
  if (currency.toUpperCase() === settings.baseCurrency.toUpperCase()) {
    return { converted: amount, usedRate: 1 }
  }
  // Rate keys are stored as entered (e.g. "EUR"); match case-insensitively
  // rather than assuming the admin always typed uppercase.
  const rateKey = Object.keys(settings.rates).find(
    (k) => k.toUpperCase() === currency.toUpperCase(),
  )
  if (!rateKey) return null
  const rate = settings.rates[rateKey]
  // Same failure class as the policy-limit bug, found the same way while
  // auditing the other place a human types a raw number into this system:
  // a malformed or zero rate (NaN, 0, or negative) makes `amount * rate`
  // become 0, NaN, or negative — and `that > limitAmount` is then always
  // false, silently PASSing every claim in that currency forever. Treated
  // the same way missing-conversion already is: no conversion possible,
  // not a fabricated zero.
  if (!Number.isFinite(rate) || rate <= 0) return null
  return { converted: amount * rate, usedRate: rate }
}

/** Policy Engine — a deterministic module, not an AI agent (the R&A doc is
 * explicit about this: financial rule application must be consistent and
 * explainable, never a model's best guess). Never invents a policy limit,
 * a currency rate, or a missing amount — anything it can't verify with
 * data actually on hand becomes REVIEW with a specific reason code, never
 * a silent PASS. */
export function evaluatePolicy(
  data: ExtractedReceiptData,
  category: ExpenseCategory,
  policies: PolicyRecord[],
  settings: PolicySettingsRecord,
): PolicyCheckResult {
  if (data.amount === null) {
    return {
      status: 'REVIEW',
      reasonCode: 'AMOUNT_MISSING',
      message: 'No amount was extracted — cannot evaluate against a spending limit.',
      convertedAmount: null,
      baseCurrency: settings.baseCurrency,
    }
  }

  // A real expense receipt's total is never zero or negative — a value
  // like this only happens from a genuine extraction misread (e.g. a
  // minus sign or a refund line mistaken for the total). Found by
  // deliberately testing a negative amount during Phase 16: without this
  // check, -50 numerically passes "within" any positive limit and would
  // have silently APPROVED a nonsensical claim instead of flagging it —
  // exactly the kind of silent-wrong-answer this module exists to avoid.
  if (data.amount <= 0) {
    return {
      status: 'REVIEW',
      reasonCode: 'AMOUNT_INVALID',
      message: `Extracted amount (${data.amount}) is zero or negative — likely a misread, not a real charge.`,
      convertedAmount: null,
      baseCurrency: settings.baseCurrency,
    }
  }

  if (!data.currency) {
    return {
      status: 'REVIEW',
      reasonCode: 'CURRENCY_UNKNOWN',
      message: 'No currency was extracted — cannot safely convert to the base currency.',
      convertedAmount: null,
      baseCurrency: settings.baseCurrency,
    }
  }

  const conversion = convertToBase(data.amount, data.currency, settings)
  if (!conversion) {
    // Gap-fix #2, applied exactly as decided: no live FX API, and an
    // unmapped currency is flagged for review — never guessed.
    return {
      status: 'REVIEW',
      reasonCode: 'CURRENCY_UNSUPPORTED',
      message: `No conversion rate on file for ${data.currency} to ${settings.baseCurrency}.`,
      convertedAmount: null,
      baseCurrency: settings.baseCurrency,
    }
  }

  const policy = policies.find((p) => p.category.toLowerCase() === category.toLowerCase())
  if (!policy) {
    return {
      status: 'REVIEW',
      reasonCode: 'NO_POLICY_DEFINED',
      message: `No spending limit is configured for category "${category}".`,
      convertedAmount: conversion.converted,
      baseCurrency: settings.baseCurrency,
    }
  }

  // Defense-in-depth against a malformed stored limit (e.g. NaN from bad
  // input that predates UI-level validation, or any future write path that
  // doesn't validate as strictly as this one does). Found live: in
  // JavaScript, `anything > NaN` is always false — a NaN limit wouldn't
  // just fail to work, it would make every claim in that category silently
  // PASS regardless of amount, forever, with no error and no review flag.
  // Exactly the "invented"/silently-wrong outcome this module exists to
  // prevent, applied symmetrically to the receipt-amount check already
  // added for the same reason (gap-fix, negative/zero amounts, Phase 16).
  if (!Number.isFinite(policy.limitAmount) || policy.limitAmount <= 0) {
    return {
      status: 'REVIEW',
      reasonCode: 'POLICY_LIMIT_INVALID',
      message: `The configured limit for "${category}" (${policy.limitAmount}) isn't a valid positive number — cannot evaluate against it.`,
      convertedAmount: conversion.converted,
      baseCurrency: settings.baseCurrency,
    }
  }

  if (conversion.converted > policy.limitAmount) {
    const code = `${category.toUpperCase()}_LIMIT_EXCEEDED`
    return {
      status: 'VIOLATION',
      reasonCode: code,
      message: `${conversion.converted.toFixed(2)} ${settings.baseCurrency} exceeds the ${policy.limitAmount} ${settings.baseCurrency} limit for ${category}.`,
      convertedAmount: conversion.converted,
      baseCurrency: settings.baseCurrency,
    }
  }

  return {
    status: 'PASS',
    reasonCode: null,
    message: `${conversion.converted.toFixed(2)} ${settings.baseCurrency} is within the ${policy.limitAmount} ${settings.baseCurrency} limit for ${category}.`,
    convertedAmount: conversion.converted,
    baseCurrency: settings.baseCurrency,
  }
}
