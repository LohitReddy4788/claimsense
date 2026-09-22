import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { generateId } from '../utils/id'
import type { PolicyRecord, PolicySettingsRecord } from '../types/records'

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
    const record: PolicyRecord = {
      policyId: generateId('pol'),
      category: category.trim(),
      limitAmount: Number(limitAmount),
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
