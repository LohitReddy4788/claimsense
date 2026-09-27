import { useEffect, useState } from 'react'
import { Download, Loader2, Save, ShieldCheck, CircleAlert, CheckCircle2, Clock, FileEdit, Receipt, Plane } from 'lucide-react'
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Claims ({claims.length})
        </p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Download className="h-3.5 w-3.5" strokeWidth={2} />}
          {exporting ? 'Exporting…' : 'Export approved claims (XLSX)'}
        </button>
      </div>
      {exportMessage && (
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{exportMessage}</p>
      )}
      {claims.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50/60 py-12 text-center dark:border-neutral-800 dark:bg-neutral-900/40">
          <Receipt className="h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No claims yet — extract a receipt in Upload Receipts first.
          </p>
        </div>
      ) : (
        <ul className="mt-3 space-y-4">
          {claims.map((c) => {
            const buf = edits[c.claimId] ?? toBuffer(c)
            const receipt = receiptsById[c.receiptId]
            const statusBadge =
              c.status === 'approved'
                ? { className: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300', icon: CheckCircle2 }
                : c.status === 'review'
                  ? { className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', icon: Clock }
                  : { className: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300', icon: FileEdit }
            const StatusIcon = statusBadge.icon
            return (
              <li
                key={c.claimId}
                className="rounded-2xl border border-neutral-200 bg-white p-4 text-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                    {receipt?.fileName ?? c.receiptId}
                  </p>
                  <span className={`inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge.className}`}>
                    <StatusIcon className="h-3 w-3" strokeWidth={2} />
                    {c.status}
                  </span>
                </div>

                {c.duplicateOfClaimId && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                    <CircleAlert className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
                    Possible duplicate of claim {c.duplicateOfClaimId}
                  </p>
                )}
                {c.lineItemReviewReason && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                    <CircleAlert className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
                    {c.lineItemReviewReason}
                  </p>
                )}

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="text-xs text-neutral-500 dark:text-neutral-400">
                    Vendor
                    <input
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-neutral-50 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
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
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-neutral-50 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
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
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-neutral-50 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
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
                      className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-neutral-50 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
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

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-100 pt-2.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <span>Date: {c.date ?? '—'}</span>
                  <span className="flex items-center gap-1">
                    <Plane className="h-3 w-3" strokeWidth={2} />
                    {c.travelRequestId ? `linked (${c.travelRequestId})` : 'not linked'}
                  </span>
                  <span title="From original extraction, not re-checked after edits">
                    Policy: {c.policyResult ?? '—'}
                    {c.policyReasonCode && ` (${c.policyReasonCode})`}
                  </span>
                </div>

                {c.status !== 'approved' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSave(c.claimId)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      <Save className="h-3.5 w-3.5" strokeWidth={2} />
                      Save changes
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApprove(c.claimId)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} />
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
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                    Approved {c.approvedAt && new Date(c.approvedAt).toLocaleString()}
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
