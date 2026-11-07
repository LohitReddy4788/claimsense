import { useEffect, useRef, useState } from 'react'
import {
  Coins,
  FileUp,
  ListChecks,
  Loader2,
  CircleAlert,
  Cpu,
  Check,
  X,
  Landmark,
} from 'lucide-react'
import * as repo from '../modules/storage/repository'
import { generateId } from '../utils/id'
import type { PolicyRecord, PolicySettingsRecord } from '../types/records'
import { extractPolicyFromPdf, MAX_POLICY_PDF_PAGES, type PolicyReadMethod } from '../agents/policy-import/extractPolicyFromPdf'
import { EXPENSE_CATEGORIES } from '../types/category'
import { LoadingState, errorText } from './LoadingState'
import type { PolicyRateCandidate, PolicyRuleCandidate } from '../types/extraction'

const METHOD_LABEL: Record<PolicyReadMethod, string> = {
  text: "the PDF's own text",
  ocr: 'OCR',
  ai: 'the on-device AI',
}

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
    | { phase: 'reading'; pageNumber: number; pagesToRead: number; method: PolicyReadMethod | null }
    | { phase: 'error'; reason: string }
    | { phase: 'done'; pagesRead: number; totalPageCount: number; method: PolicyReadMethod; rules: number; rates: number }
  >({ phase: 'idle' })
  const [suggestions, setSuggestions] = useState<PolicyRuleCandidate[]>([])
  const [rateSuggestions, setRateSuggestions] = useState<PolicyRateCandidate[]>([])
  // Suggestions whose Add is already saving. Found in testing: a quick
  // second click landed before the row disappeared and saved the same
  // limit twice. Checked synchronously, so even two clicks in one frame
  // save once.
  const saving = useRef(new Set<object>())

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function refresh() {
    try {
      const [allPolicies, savedSettings] = await Promise.all([
        repo.listPolicies(),
        repo.getPolicySettings(),
      ])
      setPolicies(allPolicies)
      setSettings(savedSettings ?? DEFAULT_SETTINGS)
      setLoaded(true)
      setLoadError(null)
    } catch (err) {
      console.error('PoliciesPanel refresh failed:', err)
      setLoadError(errorText(err))
    }
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
    await repo.addPolicy(record)
    // Category is a dropdown now, not free text — leaving the selection
    // as-is (rather than resetting) is the better default for adding
    // several limits in a row without re-picking the category each time.
    setLimitAmount('')
    await refresh()
  }

  // Both settings writes merge into what's stored NOW rather than into this
  // panel's copy: the copy can be the defaults (first read still in flight)
  // or stale (changed in another tab), and saving it would silently wipe
  // the real rate table.
  async function currentSettings(): Promise<PolicySettingsRecord> {
    return (await repo.getPolicySettings()) ?? DEFAULT_SETTINGS
  }

  async function saveBaseCurrency(currency: string) {
    const updated = { ...(await currentSettings()), baseCurrency: currency.toUpperCase() }
    await repo.putPolicySettings(updated)
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
    const stored = await currentSettings()
    const updated: PolicySettingsRecord = {
      ...stored,
      rates: { ...stored.rates, [newCurrency.trim().toUpperCase()]: parsedRate },
    }
    await repo.putPolicySettings(updated)
    setSettings(updated)
    setNewCurrency('')
    setNewRate('')
  }

  async function handlePolicyPdf(file: File) {
    setSuggestions([])
    setRateSuggestions([])
    setImportStatus({ phase: 'reading', pageNumber: 0, pagesToRead: 0, method: null })
    const result = await extractPolicyFromPdf(file, ({ pageNumber, pagesToRead, method }) =>
      setImportStatus({ phase: 'reading', pageNumber, pagesToRead, method }),
    )
    if (!result.success) {
      setImportStatus({ phase: 'error', reason: result.reason })
      return
    }
    setSuggestions(result.candidates)
    setRateSuggestions(result.rates)
    setImportStatus({
      phase: 'done',
      pagesRead: result.pagesRead,
      totalPageCount: result.totalPageCount,
      method: result.method,
      rules: result.candidates.length,
      rates: result.rates.length,
    })
  }

  // Same rule as limits: a rate from the PDF is only saved on a click.
  async function addRateSuggestion(candidate: PolicyRateCandidate) {
    if (saving.current.has(candidate)) return
    saving.current.add(candidate)
    setRateSuggestions((prev) => prev.filter((c) => c !== candidate))
    try {
      const stored = await currentSettings()
      const updated: PolicySettingsRecord = { ...stored, rates: { ...stored.rates, [candidate.currency]: candidate.rate } }
      await repo.putPolicySettings(updated)
      setSettings(updated)
    } catch (err) {
      console.error('Saving the imported rate failed:', err)
      setRateSuggestions((prev) => [...prev, candidate])
      setRateError(`Could not save the ${candidate.currency} rate: ${errorText(err)}`)
    } finally {
      saving.current.delete(candidate)
    }
  }

  // The only place a policy-import suggestion ever becomes a real rule —
  // one row, one explicit click. Nothing from the PDF read is ever saved
  // automatically, matching the same "never invent a value silently"
  // principle used everywhere else in the app, but stricter here: a wrong
  // policy limit has no downstream review to catch it the way a wrong
  // receipt field does.
  async function addSuggestion(candidate: PolicyRuleCandidate) {
    if (saving.current.has(candidate)) return
    saving.current.add(candidate)
    setSuggestions((prev) => prev.filter((c) => c !== candidate))
    const record: PolicyRecord = {
      policyId: generateId('pol'),
      category: candidate.category,
      limitAmount: candidate.limitAmount,
    }
    try {
      await repo.addPolicy(record)
    } catch (err) {
      console.error('Saving the imported limit failed:', err)
      setSuggestions((prev) => [...prev, candidate])
      setPolicyError(`Could not save the ${candidate.category} limit: ${errorText(err)}`)
    } finally {
      saving.current.delete(candidate)
    }
    await refresh()
  }

  function dismissSuggestion(candidate: PolicyRuleCandidate) {
    setSuggestions((prev) => prev.filter((c) => c !== candidate))
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/15 p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <Landmark className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Base currency &amp; conversion table</p>
            <p className="text-xs text-white/50">
              No live FX API (would violate zero-network) — rates are entered manually. A missing currency is
              flagged for review, never guessed.
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <label className="text-sm text-white/70">Base currency</label>
          <input
            className="w-24 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm font-medium text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
            value={settings.baseCurrency}
            onChange={(e) => saveBaseCurrency(e.target.value)}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/10 pt-4">
          <div>
            <label className="block text-xs text-white/50">Currency code</label>
            <input
              className="w-24 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              placeholder="EUR"
              value={newCurrency}
              onChange={(e) => setNewCurrency(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-white/50">Rate → base</label>
            <input
              className="w-28 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              placeholder="1.08"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addRate}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
          >
            <Coins className="h-4 w-4" strokeWidth={1.75} />
            Add rate
          </button>
        </div>
        {rateError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-white">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
            {rateError}
          </p>
        )}
        {Object.keys(settings.rates).length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {Object.entries(settings.rates).map(([code, rate]) => (
              <li key={code} className="rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80">
                1 {code} = {rate} {settings.baseCurrency}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-white/15 p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <FileUp className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Import limits from a policy PDF</p>
            <p className="text-xs text-white/50">
              Reads limits and currency rates from up to {MAX_POLICY_PDF_PAGES} pages on-device (the PDF's text,
              then OCR, then the AI) — nothing is saved until you click Add on a specific row.
            </p>
          </div>
        </div>

        <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-white/30 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:border-white hover:bg-white/5">
          <FileUp className="h-4 w-4" strokeWidth={1.75} />
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
          <p className="mt-3 flex items-center gap-1.5 text-sm text-white/60">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            {importStatus.method === 'ai'
              ? `No limits found in the text, so the on-device AI is reading page ${importStatus.pageNumber} of ${importStatus.pagesToRead}… this can take several minutes per page.`
              : importStatus.method === 'ocr'
                ? `Reading page ${importStatus.pageNumber} of ${importStatus.pagesToRead} with OCR…`
                : 'Reading the PDF…'}
          </p>
        )}
        {importStatus.phase === 'error' && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-white">
            <CircleAlert className="h-4 w-4 flex-none" strokeWidth={1.75} />
            Could not read this PDF: {importStatus.reason}
          </p>
        )}
        {importStatus.phase === 'done' && (
          <p className="mt-3 text-sm text-white/60">
            Read {importStatus.pagesRead} of {importStatus.totalPageCount} page
            {importStatus.totalPageCount === 1 ? '' : 's'}.{' '}
            {importStatus.rules === 0
              ? 'No spending limits found.'
              : `Found ${importStatus.rules} spending limit${importStatus.rules === 1 ? '' : 's'}`}
            {importStatus.rates > 0 && ` and ${importStatus.rates} currency rate${importStatus.rates === 1 ? '' : 's'}`}
            {importStatus.rules > 0 && `, read with ${METHOD_LABEL[importStatus.method]}.`}
            {importStatus.rules > 0 && suggestions.length === 0 && rateSuggestions.length === 0 && ' All handled.'}
          </p>
        )}
        {suggestions.length > 0 && (
          <ul className="mt-3 space-y-2">
            {suggestions.map((s, i) => (
              <li
                key={`${s.category}-${i}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/25 px-3.5 py-2.5 text-sm"
              >
                <span className="flex items-center gap-2 text-white">
                  <Cpu className="h-3.5 w-3.5 flex-none text-white/60" strokeWidth={1.75} />
                  <span className="font-medium">{s.category}</span>
                  {s.writtenAs && s.writtenAs.toLowerCase() !== s.category.toLowerCase() && (
                    <span className="text-white/50"> (written as "{s.writtenAs}")</span>
                  )}{' '}
                  — {s.limitAmount} {settings.baseCurrency}
                  {!EXPENSE_CATEGORIES.some((c) => c.toLowerCase() === s.category.toLowerCase()) && (
                    <span className="block text-xs text-white/60">
                      Not one of the app's categories, so it won't apply to any receipt.
                    </span>
                  )}
                </span>
                <span className="flex flex-none gap-1.5">
                  <button
                    type="button"
                    onClick={() => addSuggestion(s)}
                    className="inline-flex items-center gap-1 rounded-md border border-white bg-white px-2.5 py-1 text-xs font-medium text-black transition-colors hover:bg-white/90"
                  >
                    <Check className="h-3 w-3" strokeWidth={2.25} />
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissSuggestion(s)}
                    className="inline-flex items-center gap-1 rounded-md border border-white/30 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
                  >
                    <X className="h-3 w-3" strokeWidth={2.25} />
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {rateSuggestions.length > 0 && (
          <ul className="mt-2 space-y-2">
            {rateSuggestions.map((r) => {
              const usable = r.toCurrency === settings.baseCurrency
              return (
                <li
                  key={r.currency}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/25 px-3.5 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2 text-white">
                    <Coins className="h-3.5 w-3.5 flex-none text-white/60" strokeWidth={1.75} />
                    <span className="font-medium">Rate</span> — 1 {r.currency} = {r.rate} {r.toCurrency}
                    {!usable && (
                      <span className="block text-xs text-white/60">
                        Not in the base currency ({settings.baseCurrency}), so it can't be added.
                      </span>
                    )}
                  </span>
                  <span className="flex flex-none gap-1.5">
                    {usable && (
                      <button
                        type="button"
                        onClick={() => addRateSuggestion(r)}
                        className="inline-flex items-center gap-1 rounded-md border border-white bg-white px-2.5 py-1 text-xs font-medium text-black transition-colors hover:bg-white/90"
                      >
                        <Check className="h-3 w-3" strokeWidth={2.25} />
                        Add
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setRateSuggestions((prev) => prev.filter((c) => c !== r))}
                      className="inline-flex items-center gap-1 rounded-md border border-white/30 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
                    >
                      <X className="h-3 w-3" strokeWidth={2.25} />
                      Dismiss
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-white/15 p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <ListChecks className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <p className="text-sm font-semibold text-white">Category spending limits ({loaded ? policies.length : '…'})</p>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/10 pt-4">
          <div>
            <label className="block text-xs text-white/50">Category</label>
            <select
              className="w-40 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
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
            <label className="block text-xs text-white/50">Limit ({settings.baseCurrency})</label>
            <input
              className="w-28 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              placeholder="200"
              value={limitAmount}
              onChange={(e) => setLimitAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addPolicy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
          >
            <ListChecks className="h-4 w-4" strokeWidth={1.75} />
            Add rule
          </button>
        </div>
        {policyError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-white">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
            {policyError}
          </p>
        )}
        {!loaded ? (
          <LoadingState error={loadError} />
        ) : policies.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">No policy rules yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-white/10">
            {policies.map((p) => (
              <li key={p.policyId} className="flex items-center justify-between py-2.5 text-sm">
                <span className="font-medium text-white">{p.category}</span>
                <span className="rounded-full border border-white/25 px-2.5 py-0.5 text-xs font-medium text-white/70">
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
