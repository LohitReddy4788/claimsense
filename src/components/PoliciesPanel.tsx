import { useEffect, useState } from 'react'
import {
  Coins,
  FileUp,
  ListChecks,
  Loader2,
  CircleAlert,
  Sparkles,
  Check,
  X,
  Landmark,
} from 'lucide-react'
import { db } from '../modules/storage/db'
import { generateId } from '../utils/id'
import type { PolicyRecord, PolicySettingsRecord } from '../types/records'
import { extractPolicyFromPdf, MAX_POLICY_PDF_PAGES } from '../agents/policy-import/extractPolicyFromPdf'
import { EXPENSE_CATEGORIES } from '../types/category'
import type { PolicyRuleCandidate } from '../types/extraction'

const DEFAULT_SETTINGS: PolicySettingsRecord = {
  id: 'default',
  baseCurrency: 'USD',
  rates: {},
}

export function PoliciesPanel() {
  const [policies, setPolicies] = useState<PolicyRecord[]>([])
  const [settings, setSettings] = useState<PolicySettingsRecord>(DEFAULT_SETTINGS)
  // A dropdown constrained to exactly what classifyCategory.ts can ever
  // produce — not free text. Found live: the old text field's own
  // placeholder ("Hotel") wasn't even a real category (the classifier
  // only ever assigns "Lodging"), so following that hint created a policy
  // rule that could never match a single real claim, silently. A rule
  // typed for any category the classifier can't produce has the same
  // problem — constraining the input to the classifier's own vocabulary
  // is what actually fixes it, not just tidies it.
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0])
  const [limitAmount, setLimitAmount] = useState('')
  const [newCurrency, setNewCurrency] = useState('')
  const [newRate, setNewRate] = useState('')
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)

  // Suggestions from a policy-PDF import (Version A: read-only until a
  // human confirms). Kept entirely separate from `policies` (the real,
  // saved rules) — nothing here is a policy until addSuggestion() below
  // moves one row across, one row at a time, on an explicit click.
  const [importStatus, setImportStatus] = useState<
    | { phase: 'idle' }
    | { phase: 'reading'; pageNumber: number; pagesToRead: number }
    | { phase: 'error'; reason: string }
    | { phase: 'done'; pagesRead: number; totalPageCount: number }
  >({ phase: 'idle' })
  const [suggestions, setSuggestions] = useState<PolicyRuleCandidate[]>([])

  async function refresh() {
    const [allPolicies, savedSettings] = await Promise.all([
      db.policies.orderBy('category').toArray(),
      db.policySettings.get('default'),
    ])
    setPolicies(allPolicies)
    setSettings(savedSettings ?? DEFAULT_SETTINGS)
  }

  useEffect(() => {
    refresh()
  }, [])

  async function addPolicy() {
    if (!category || !limitAmount) return
    const parsedLimit = Number(limitAmount)
    // Found live: with no validation here, a malformed entry becomes NaN,
    // and the Policy Engine's `amount > NaN` comparison is always false in
    // JavaScript — silently PASSing every future claim in that category,
    // forever, with no error shown anywhere. Reject bad input at the
    // source instead of only catching it downstream.
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      setPolicyError('Limit must be a positive number.')
      return
    }
    setPolicyError(null)
    const record: PolicyRecord = {
      policyId: generateId('pol'),
      category,
      limitAmount: parsedLimit,
    }
    await db.policies.add(record)
    // Category is a dropdown now, not free text — leaving the selection
    // as-is (rather than resetting) is the better default for adding
    // several limits in a row without re-picking the category each time.
    setLimitAmount('')
    await refresh()
  }

  async function saveBaseCurrency(currency: string) {
    const updated = { ...settings, baseCurrency: currency.toUpperCase() }
    await db.policySettings.put(updated)
    setSettings(updated)
  }

  async function addRate() {
    if (!newCurrency.trim() || !newRate) return
    const parsedRate = Number(newRate)
    // Same bug class as the policy-limit fix, same reason: a malformed or
    // zero rate makes every future conversion for that currency come out
    // as 0/NaN, which the Policy Engine's `> limit` check reads as always
    // within limits — silently disabling enforcement for that currency.
    if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
      setRateError('Rate must be a positive number.')
      return
    }
    setRateError(null)
    const updated: PolicySettingsRecord = {
      ...settings,
      rates: { ...settings.rates, [newCurrency.trim().toUpperCase()]: parsedRate },
    }
    await db.policySettings.put(updated)
    setSettings(updated)
    setNewCurrency('')
    setNewRate('')
  }

  async function handlePolicyPdf(file: File) {
    setSuggestions([])
    setImportStatus({ phase: 'reading', pageNumber: 0, pagesToRead: 0 })
    const result = await extractPolicyFromPdf(file, ({ pageNumber, pagesToRead }) =>
      setImportStatus({ phase: 'reading', pageNumber, pagesToRead }),
    )
    if (!result.success) {
      setImportStatus({ phase: 'error', reason: result.reason })
      return
    }
    setSuggestions(result.candidates)
    setImportStatus({ phase: 'done', pagesRead: result.pagesRead, totalPageCount: result.totalPageCount })
  }

  // The only place a policy-import suggestion ever becomes a real rule —
  // one row, one explicit click. Nothing from the PDF read is ever saved
  // automatically, matching the same "never invent a value silently"
  // principle used everywhere else in the app, but stricter here: a wrong
  // policy limit has no downstream review to catch it the way a wrong
  // receipt field does.
  async function addSuggestion(candidate: PolicyRuleCandidate) {
    const record: PolicyRecord = {
      policyId: generateId('pol'),
      category: candidate.category,
      limitAmount: candidate.limitAmount,
    }
    await db.policies.add(record)
    setSuggestions((prev) => prev.filter((c) => c !== candidate))
    await refresh()
  }

  function dismissSuggestion(candidate: PolicyRuleCandidate) {
    setSuggestions((prev) => prev.filter((c) => c !== candidate))
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/40">
            <Landmark className="h-4 w-4 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <div>
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Base currency &amp; conversion table
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              No live FX API (would violate zero-network) — rates are entered manually. A missing currency is
              flagged for review, never guessed.
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <label className="text-sm text-neutral-600 dark:text-neutral-300">Base currency</label>
          <input
            className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-sm font-medium focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
            value={settings.baseCurrency}
            onChange={(e) => saveBaseCurrency(e.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Currency code</label>
            <input
              className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              placeholder="EUR"
              value={newCurrency}
              onChange={(e) => setNewCurrency(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Rate → base</label>
            <input
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              placeholder="1.08"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addRate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700"
          >
            <Coins className="h-4 w-4" strokeWidth={2} />
            Add rate
          </button>
        </div>
        {rateError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
            {rateError}
          </p>
        )}
        {Object.keys(settings.rates).length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {Object.entries(settings.rates).map(([code, rate]) => (
              <li
                key={code}
                className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                1 {code} = {rate} {settings.baseCurrency}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/40">
            <FileUp className="h-4 w-4 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <div>
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Import limits from a policy PDF
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Reads up to {MAX_POLICY_PDF_PAGES} pages on-device — nothing is saved until you click Add on a
              specific row.
            </p>
          </div>
        </div>

        <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-600 transition-colors hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/30">
          <FileUp className="h-4 w-4" strokeWidth={2} />
          Choose a policy PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) handlePolicyPdf(file)
            }}
            disabled={importStatus.phase === 'reading'}
            className="hidden"
          />
        </label>

        {importStatus.phase === 'reading' && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            {importStatus.pagesToRead > 0
              ? `Reading page ${importStatus.pageNumber} of ${importStatus.pagesToRead}… this can take several minutes per page on-device.`
              : 'Rendering PDF pages…'}
          </p>
        )}
        {importStatus.phase === 'error' && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
            <CircleAlert className="h-4 w-4 flex-none" strokeWidth={2} />
            Could not read this PDF: {importStatus.reason}
          </p>
        )}
        {importStatus.phase === 'done' && (
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            Read {importStatus.pagesRead} of {importStatus.totalPageCount} page
            {importStatus.totalPageCount === 1 ? '' : 's'}.{' '}
            {suggestions.length === 0
              ? 'No spending limits found.'
              : `Found ${suggestions.length} candidate rule${suggestions.length === 1 ? '' : 's'} below.`}
          </p>
        )}
        {suggestions.length > 0 && (
          <ul className="mt-3 space-y-2">
            {suggestions.map((s, i) => (
              <li
                key={`${s.category}-${i}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/50 px-3.5 py-2.5 text-sm dark:border-brand-900 dark:bg-brand-950/30"
              >
                <span className="flex items-center gap-2 text-neutral-800 dark:text-neutral-100">
                  <Sparkles className="h-3.5 w-3.5 flex-none text-brand-500" strokeWidth={2} />
                  <span className="font-medium">{s.category}</span> — {s.limitAmount} {settings.baseCurrency}
                </span>
                <span className="flex flex-none gap-1.5">
                  <button
                    type="button"
                    onClick={() => addSuggestion(s)}
                    className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-700"
                  >
                    <Check className="h-3 w-3" strokeWidth={2.5} />
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissSuggestion(s)}
                    className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    <X className="h-3 w-3" strokeWidth={2.5} />
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/40">
            <ListChecks className="h-4 w-4 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Category spending limits ({policies.length})
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Category</label>
            <select
              className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {EXPENSE_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">
              Limit ({settings.baseCurrency})
            </label>
            <input
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              placeholder="200"
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addPolicy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700"
          >
            <ListChecks className="h-4 w-4" strokeWidth={2} />
            Add rule
          </button>
        </div>
        {policyError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
            {policyError}
          </p>
        )}
        {policies.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">No policy rules yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800">
            {policies.map((p) => (
              <li key={p.policyId} className="flex items-center justify-between py-2.5 text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{p.category}</span>
                <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {p.limitAmount} {settings.baseCurrency}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
