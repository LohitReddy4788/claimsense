import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { editClaim, approveClaim } from '../agents/review/reviewClaim'
import { exportApprovedClaims } from '../agents/export/exportClaims'
import { EXPENSE_CATEGORIES } from '../types/category'
import type { ClaimRecord, ReceiptRecord } from '../types/records'

interface EditBuffer {
  vendor: string
  amount: string
  currency: string
  category: string
}

function toBuffer(c: ClaimRecord): EditBuffer {
  return {
    vendor: c.vendor ?? '',
    amount: c.amount === null ? '' : String(c.amount),
    currency: c.currency ?? '',
    category: c.category,
  }
}

interface ClaimsPanelProps {
  /** Panels stay mounted for the whole session (Phase 5's fix) — without
   * this, a claim created in Upload Receipts after this panel first
   * mounted would never appear here. Same staleness class of bug already
   * found twice (Phase 8's travel requests, Phase 9's policies) — fixing
   * it here proactively instead of waiting to hit it a third time.
   * Re-fetches every time this tab becomes the active one. */
  active: boolean
}

export function ClaimsPanel({ active }: ClaimsPanelProps) {
  const [claims, setClaims] = useState<ClaimRecord[]>([])
  const [receiptsById, setReceiptsById] = useState<Record<string, ReceiptRecord>>({})
  const [edits, setEdits] = useState<Record<string, EditBuffer>>({})
  const [message, setMessage] = useState<Record<string, string>>({})
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  async function refresh() {
    try {
      const [allClaims, allReceipts] = await Promise.all([
        db.claims.orderBy('createdAt').reverse().toArray(),
        db.receipts.toArray(),
      ])
      setClaims(allClaims)
      setReceiptsById(Object.fromEntries(allReceipts.map((r) => [r.receiptId, r])))
      // Seed edit buffers for any claim that doesn't have one yet — never
      // clobber a buffer the user is actively editing.
      setEdits((prev) => {
        const next = { ...prev }
        for (const c of allClaims) {
          if (!next[c.claimId]) next[c.claimId] = toBuffer(c)
        }
        return next
      })
    } catch (err) {
      // A failed refresh must be visible, not a silent no-op — this is
      // exactly how the createdAt-index bug hid itself during testing.
      console.error('ClaimsPanel refresh failed:', err)
    }
  }

  useEffect(() => {
    if (active) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  async function handleSave(claimId: string) {
    const buf = edits[claimId]
    if (!buf) return
    const amount = buf.amount.trim() === '' ? null : Number(buf.amount)
    if (buf.amount.trim() !== '' && Number.isNaN(amount)) {
      setMessage((m) => ({ ...m, [claimId]: 'Amount must be a number.' }))
      return
    }
    // editClaim/db.claims.update can throw on a genuine storage error (quota,
    // corruption) — without this, that failure was an unhandled rejection
    // with nothing shown on screen, the same silent-failure class refresh()
    // above is already guarded against.
    try {
      await editClaim(claimId, {
        vendor: buf.vendor.trim() === '' ? null : buf.vendor.trim(),
        amount,
        currency: buf.currency.trim() === '' ? null : buf.currency.trim(),
        category: buf.category,
      })
      setMessage((m) => ({ ...m, [claimId]: 'Saved.' }))
      await refresh()
    } catch (err) {
      setMessage((m) => ({
        ...m,
        [claimId]: `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      }))
    }
  }

  async function handleApprove(claimId: string) {
    try {
      const result = await approveClaim(claimId)
      setMessage((m) => ({
        ...m,
        [claimId]: result.success ? 'Approved.' : `Could not approve: ${result.reason}`,
      }))
      await refresh()
    } catch (err) {
      setMessage((m) => ({
        ...m,
        [claimId]: `Could not approve: ${err instanceof Error ? err.message : String(err)}`,
      }))
    }
  }

  async function handleExport() {
    setExporting(true)
    const result = await exportApprovedClaims()
    setExportMessage(
      result.success
        ? `✓ Exported ${result.claimCount} approved claim(s) to ${result.fileName}`
        : `⚠ ${result.reason}`,
    )
    setExporting(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Claims ({claims.length})
        </p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {exporting ? 'Exporting…' : 'Export approved claims (XLSX)'}
        </button>
      </div>
      {exportMessage && (
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{exportMessage}</p>
      )}
      {claims.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          No claims yet — extract a receipt in Upload Receipts first.
        </p>
      ) : (
        <ul className="mt-3 space-y-4">
          {claims.map((c) => {
            const buf = edits[c.claimId] ?? toBuffer(c)
            const receipt = receiptsById[c.receiptId]
            const statusBadge =
              c.status === 'approved'
                ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                : c.status === 'review'
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
            return (
              <li
                key={c.claimId}
                className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800"
              >
                <div className="flex items-center justify-between">
                  <p className="font-medium text-neutral-900 dark:text-neutral-100">
                    {receipt?.fileName ?? c.receiptId}
                  </p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge}`}>
                    {c.status}
                  </span>
                </div>

                {c.duplicateOfClaimId && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    ⚠ Possible duplicate of claim {c.duplicateOfClaimId}
                  </p>
                )}

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">
                    Vendor
                    <input
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      value={buf.vendor}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, vendor: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">
                    Amount
                    <input
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      value={buf.amount}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, amount: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">
                    Currency
                    <input
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      value={buf.currency}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, currency: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">
                    Category
                    <select
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      value={buf.category}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, category: e.target.value } }))
                      }
                    >
                      {EXPENSE_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  Date: {c.date ?? '—'} · Travel:{' '}
                  {c.travelRequestId ? `linked (${c.travelRequestId})` : 'not linked'}
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Policy (from original extraction, not re-checked after edits):{' '}
                  {c.policyResult ?? '—'}
                  {c.policyReasonCode && ` (${c.policyReasonCode})`}
                </p>

                {c.status !== 'approved' && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSave(c.claimId)}
                      className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      Save changes
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApprove(c.claimId)}
                      className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                    >
                      Approve &amp; submit
                    </button>
                    {message[c.claimId] && (
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        {message[c.claimId]}
                      </span>
                    )}
                  </div>
                )}
                {c.status === 'approved' && (
                  <p className="mt-3 text-xs text-green-700 dark:text-green-400">
                    ✓ Approved {c.approvedAt && new Date(c.approvedAt).toLocaleString()}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
