import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { generateId } from '../utils/id'
import type { PolicyRecord, PolicySettingsRecord } from '../types/records'
import { extractPolicyFromPdf, MAX_POLICY_PDF_PAGES } from '../agents/policy-import/extractPolicyFromPdf'
import type { PolicyRuleCandidate } from '../types/extraction'

const DEFAULT_SETTINGS: PolicySettingsRecord = {
  id: 'default',
  baseCurrency: 'USD',
  rates: {},
}

export function PoliciesPanel() {
  const [policies, setPolicies] = useState<PolicyRecord[]>([])
  const [settings, setSettings] = useState<PolicySettingsRecord>(DEFAULT_SETTINGS)
  const [category, setCategory] = useState('')
  const [limitAmount, setLimitAmount] = useState('')
  const [newCurrency, setNewCurrency] = useState('')
  const [newRate, setNewRate] = useState('')
  const [policyError, setPolicyError] = useState<string | null>(null)

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
    if (!category.trim() || !limitAmount) return
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
      category: category.trim(),
      limitAmount: parsedLimit,
    }
    await db.policies.add(record)
    setCategory('')
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
    const updated: PolicySettingsRecord = {
      ...settings,
      rates: { ...settings.rates, [newCurrency.trim().toUpperCase()]: Number(newRate) },
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
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Base currency &amp; conversion table
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          No live FX API (would violate zero-network) — rates are entered manually. A receipt currency missing
          here is flagged CURRENCY_UNSUPPORTED for review, never guessed.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <label className="text-sm text-neutral-600 dark:text-neutral-300">Base currency:</label>
          <input
            className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            value={settings.baseCurrency}
            onChange={(e) => saveBaseCurrency(e.target.value)}
          />
        </div>
        <div className="mt-3 flex items-end gap-2">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Currency code</label>
            <input
              className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="EUR"
              value={newCurrency}
              onChange={(e) => setNewCurrency(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Rate → base</label>
            <input
              className="w-28 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="1.08"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addRate}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add rate
          </button>
        </div>
        {Object.keys(settings.rates).length > 0 && (
          <ul className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
            {Object.entries(settings.rates).map(([code, rate]) => (
              <li key={code}>
                1 {code} = {rate} {settings.baseCurrency}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Import limits from a policy PDF
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Reads up to {MAX_POLICY_PDF_PAGES} pages on-device (no API, nothing leaves this machine) and suggests
          rules below — nothing is saved until you click Add on a specific row.
        </p>
        <div className="mt-3">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) handlePolicyPdf(file)
            }}
            disabled={importStatus.phase === 'reading'}
            className="text-sm text-neutral-600 dark:text-neutral-300"
          />
        </div>
        {importStatus.phase === 'reading' && (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            {importStatus.pagesToRead > 0
              ? `Reading page ${importStatus.pageNumber} of ${importStatus.pagesToRead}… this can take several minutes per page on-device.`
              : 'Rendering PDF pages…'}
          </p>
        )}
        {importStatus.phase === 'error' && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">Could not read this PDF: {importStatus.reason}</p>
        )}
        {importStatus.phase === 'done' && (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Read {importStatus.pagesRead} of {importStatus.totalPageCount} page
            {importStatus.totalPageCount === 1 ? '' : 's'}.{' '}
            {suggestions.length === 0
              ? 'No spending limits found.'
              : `Found ${suggestions.length} candidate rule${suggestions.length === 1 ? '' : 's'} below.`}
          </p>
        )}
        {suggestions.length > 0 && (
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {suggestions.map((s, i) => (
              <li key={`${s.category}-${i}`} className="flex items-center justify-between py-2 text-sm">
                <span className="text-neutral-900 dark:text-neutral-100">
                  {s.category} — {s.limitAmount} {settings.baseCurrency}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => addSuggestion(s)}
                    className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissSuggestion(s)}
                    className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Category spending limits ({policies.length})
        </p>
        <div className="mt-3 flex items-end gap-2">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Category</label>
            <input
              className="w-40 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="Hotel"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">
              Limit ({settings.baseCurrency})
            </label>
            <input
              className="w-28 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              placeholder="200"
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addPolicy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add rule
          </button>
        </div>
        {policyError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{policyError}</p>
        )}
        {policies.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">No policy rules yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {policies.map((p) => (
              <li key={p.policyId} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{p.category}</span>
                <span className="text-neutral-500 dark:text-neutral-400">
                  {p.limitAmount} {settings.baseCurrency}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
