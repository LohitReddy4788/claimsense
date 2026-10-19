import { useEffect, useState } from 'react'
import { Download, Loader2, Save, ShieldCheck, CircleAlert, CheckCircle2, Clock, FileEdit, Receipt, Plane } from 'lucide-react'
import * as repo from '../modules/storage/repository'
import { editClaim, approveClaim } from '../agents/review/reviewClaim'
import { exportApprovedClaims } from '../agents/export/exportClaims'
import { EXPENSE_CATEGORIES } from '../types/category'
import { LoadingState, errorText } from './LoadingState'
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
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function refresh() {
    try {
      const [allClaims, allReceipts] = await Promise.all([
        repo.listClaims(),
        repo.listReceipts(),
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
      setLoaded(true)
      setLoadError(null)
    } catch (err) {
      // A failed refresh must be visible, not a silent no-op — this is
      // exactly how the createdAt-index bug hid itself during testing.
      console.error('ClaimsPanel refresh failed:', err)
      setLoadError(errorText(err))
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
    // editClaim/repo.updateClaim can throw on a genuine storage error (quota,
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
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
          Claims ({loaded ? claims.length : '…'})
        </p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <Download className="h-3.5 w-3.5" strokeWidth={1.75} />}
          {exporting ? 'Exporting…' : 'Export approved claims (XLSX)'}
        </button>
      </div>
      {exportMessage && <p className="mt-2 text-xs text-white/60">{exportMessage}</p>}
      {!loaded ? (
        <LoadingState error={loadError} />
      ) : claims.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
          <Receipt className="h-8 w-8 text-white/25" strokeWidth={1.5} />
          <p className="text-sm text-white/50">No claims yet — extract a receipt in Upload Receipts first.</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-4">
          {claims.map((c) => {
            const buf = edits[c.claimId] ?? toBuffer(c)
            const receipt = receiptsById[c.receiptId]
            const StatusIcon =
              c.status === 'approved' ? CheckCircle2 : c.status === 'review' ? Clock : FileEdit
            return (
              <li key={c.claimId} className="rounded-2xl border border-white/15 p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium text-white">{receipt?.fileName ?? c.receiptId}</p>
                  <span className="inline-flex flex-none items-center gap-1 rounded-full border border-white/30 px-2.5 py-0.5 text-xs font-medium text-white/80">
                    <StatusIcon className="h-3 w-3" strokeWidth={1.75} />
                    {c.status}
                  </span>
                </div>

                {c.duplicateOfClaimId && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-white">
                    <CircleAlert className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                    Possible duplicate of claim {c.duplicateOfClaimId}
                  </p>
                )}
                {c.lineItemReviewReason && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-white">
                    <CircleAlert className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                    {c.lineItemReviewReason}
                  </p>
                )}

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="text-xs text-white/50">
                    Vendor
                    <input
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
                      value={buf.vendor}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, vendor: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-white/50">
                    Amount
                    <input
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
                      value={buf.amount}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, amount: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-white/50">
                    Currency
                    <input
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
                      value={buf.currency}
                      disabled={c.status === 'approved'}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, currency: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-white/50">
                    Category
                    <select
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
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

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 pt-2.5 text-xs text-white/50">
                  <span>Date: {c.date ?? '—'}</span>
                  <span className="flex items-center gap-1">
                    <Plane className="h-3 w-3" strokeWidth={1.75} />
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
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
                    >
                      <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Save changes
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApprove(c.claimId)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white/90"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Approve &amp; submit
                    </button>
                    {message[c.claimId] && (
                      <span className="text-xs text-white/50">{message[c.claimId]}</span>
                    )}
                  </div>
                )}
                {c.status === 'approved' && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-white">
                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
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
