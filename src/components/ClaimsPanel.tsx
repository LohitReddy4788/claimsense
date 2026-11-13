import { useEffect, useState } from 'react'
import { Download, Loader2, Save, ShieldCheck, XCircle, RotateCcw, Trash2, ShieldX, ShieldAlert, CircleAlert, CheckCircle2, Clock, FileEdit, Receipt, Plane, User, Send, FolderCheck } from 'lucide-react'
import * as repo from '../modules/storage/repository'
import { editClaim, approveClaim, rejectClaim, reopenClaim, withdrawClaim } from '../agents/review/reviewClaim'
import { exportClaims, type ExportScope } from '../agents/export/exportClaims'
import { submitReport, readyForReport, totalsByCurrency } from '../agents/review/submitReport'
import { EXPENSE_CATEGORIES } from '../types/category'
import { dateReadings, normalizeReceiptDate } from '../utils/receiptDate'
import { LoadingState, errorText } from './LoadingState'
import type { ClaimRecord, ClaimReportRecord, ReceiptRecord, TravelRequestRecord } from '../types/records'

interface EditBuffer {
  vendor: string
  amount: string
  currency: string
  date: string
  category: string
}

function toBuffer(c: ClaimRecord): EditBuffer {
  return {
    vendor: c.vendor ?? '',
    amount: c.amount === null ? '' : c.amount.toFixed(2),
    currency: c.currency ?? '',
    date: c.date ?? '',
    category: c.category,
  }
}

function isDirty(c: ClaimRecord, buf: EditBuffer): boolean {
  const original = toBuffer(c)
  return (Object.keys(original) as (keyof EditBuffer)[]).some((k) => original[k].trim() !== buf[k].trim())
}

// "MEALS_LIMIT_EXCEEDED" -> "Meals limit exceeded"
function readableCode(code: string): string {
  const words = code.toLowerCase().split('_').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const POLICY_BADGE = {
  PASS: { label: 'Policy passed', Icon: ShieldCheck, cls: 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300' },
  VIOLATION: { label: 'Policy violation', Icon: ShieldX, cls: 'border-red-400/50 bg-red-400/10 text-red-300' },
  REVIEW: { label: 'Needs review', Icon: ShieldAlert, cls: 'border-amber-400/50 bg-amber-400/10 text-amber-300' },
} as const

const TRIP_BADGE = {
  linked: 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300',
  suggested: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
  none: 'border-white/20 text-white/50',
} as const

const BADGE = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium'

const sameEmployee = (a: string | null | undefined, b: string) => !!a && a.trim().toUpperCase() === b.trim().toUpperCase()

type AdminFilter = 'submitted' | 'approved' | 'rejected' | 'open' | 'all'
const ADMIN_FILTERS: { id: AdminFilter; label: string; match: (c: ClaimRecord) => boolean }[] = [
  { id: 'submitted', label: 'Waiting for approval', match: (c) => c.status === 'submitted' },
  { id: 'approved', label: 'Approved', match: (c) => c.status === 'approved' },
  { id: 'rejected', label: 'Rejected', match: (c) => c.status === 'rejected' },
  { id: 'open', label: 'Not submitted yet', match: (c) => c.status === 'draft' || c.status === 'review' },
  { id: 'all', label: 'All', match: () => true },
]

interface ClaimsPanelProps {
  /** Panels stay mounted for the whole session (Phase 5's fix) — without
   * this, a claim created in Upload Receipts after this panel first
   * mounted would never appear here. Same staleness class of bug already
   * found twice (Phase 8's travel requests, Phase 9's policies) — fixing
   * it here proactively instead of waiting to hit it a third time.
   * Re-fetches every time this tab becomes the active one. */
  active: boolean
  /** Employee: their own claims, which they correct and submit. Admin:
   * everyone's, read-only, to approve or reject what was submitted. */
  portal: 'employee' | 'admin'
  /** The signed-in employee (employee portal only). */
  employeeId?: string
}

export function ClaimsPanel({ active, portal, employeeId = '' }: ClaimsPanelProps) {
  const isAdmin = portal === 'admin'
  const [filter, setFilter] = useState<AdminFilter>('submitted')
  const [claims, setClaims] = useState<ClaimRecord[]>([])
  const [receiptsById, setReceiptsById] = useState<Record<string, ReceiptRecord>>({})
  const [edits, setEdits] = useState<Record<string, EditBuffer>>({})
  const [message, setMessage] = useState<Record<string, string>>({})
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState<ExportScope | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reports, setReports] = useState<ClaimReportRecord[]>([])
  const [reportMessage, setReportMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [tripsById, setTripsById] = useState<Record<string, TravelRequestRecord>>({})
  // The claim the employee clicked Remove on, waiting for "Yes, remove".
  const [removing, setRemoving] = useState<string | null>(null)
  // Claims whose Reject is open, with the reason being typed.
  const [rejecting, setRejecting] = useState<Record<string, string>>({})

  // The trip a claim is linked to, in words a reviewer recognises (its
  // internal ID means nothing to them). Falls back to the ID if the trip
  // can't be found.
  function tripLabel(id: string): string {
    const trip = tripsById[id]
    return trip ? `${trip.destination} trip, ${trip.startDate} to ${trip.endDate}` : id
  }

  async function refresh() {
    try {
      const [allClaims, allReceipts, allReports, allTrips] = await Promise.all([
        repo.listClaims(),
        repo.listReceipts(),
        repo.listReports(),
        repo.listTravelRequests(),
      ])
      setTripsById(Object.fromEntries(allTrips.map((t) => [t.requestId, t])))
      setClaims(allClaims)
      setReports(allReports)
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

  /** Returns whether the edit was saved, so Approve can refuse to go
   * ahead on a failed save instead of approving the old values. */
  async function handleSave(claimId: string): Promise<boolean> {
    const buf = edits[claimId]
    if (!buf) return false
    const amount = buf.amount.trim() === '' ? null : Number(buf.amount)
    if (buf.amount.trim() !== '' && Number.isNaN(amount)) {
      setMessage((m) => ({ ...m, [claimId]: 'Amount must be a number.' }))
      return false
    }
    // A typed date has to be one the checks can read, or trip matching and
    // the future-date check would silently skip it.
    if (buf.date.trim() !== '' && dateReadings(buf.date).length === 0) {
      setMessage((m) => ({ ...m, [claimId]: 'Date must be a real date, e.g. 2026-03-12 or 12/03/2026.' }))
      return false
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
        date: buf.date.trim() === '' ? null : normalizeReceiptDate(buf.date),
        category: buf.category,
      })
      setMessage((m) => ({ ...m, [claimId]: 'Saved.' }))
      await refresh()
      return true
    } catch (err) {
      setMessage((m) => ({
        ...m,
        [claimId]: `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      }))
      return false
    }
  }

  async function handleApprove(claim: ClaimRecord) {
    const claimId = claim.claimId
    // Found in the pre-submission audit: approving straight after typing a
    // correction used to approve the old values and silently drop the edit.
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

  async function handleReject(claimId: string) {
    try {
      const result = await rejectClaim(claimId, rejecting[claimId] ?? '')
      setMessage((m) => ({ ...m, [claimId]: result.success ? 'Rejected.' : `Could not reject: ${result.reason}` }))
      if (result.success) {
        setRejecting((r) => {
          const next = { ...r }
          delete next[claimId]
          return next
        })
      }
      await refresh()
    } catch (err) {
      setMessage((m) => ({ ...m, [claimId]: `Could not reject: ${errorText(err)}` }))
    }
  }

  async function handleWithdraw(claimId: string) {
    const result = await withdrawClaim(claimId)
    setRemoving(null)
    if (!result.success) setMessage((m) => ({ ...m, [claimId]: `Could not remove: ${result.reason}` }))
    await refresh()
  }

  async function handleReopen(claimId: string) {
    try {
      const result = await reopenClaim(claimId)
      setMessage((m) => ({ ...m, [claimId]: result.success ? 'Sent back to the employee.' : `Could not reopen: ${result.reason}` }))
      await refresh()
    } catch (err) {
      setMessage((m) => ({ ...m, [claimId]: `Could not reopen: ${errorText(err)}` }))
    }
  }

  async function handleSubmitReport(employeeId: string) {
    setSubmitting(employeeId)
    // Unsaved corrections are saved first, so what's submitted is what the
    // employee sees on screen.
    for (const c of readyForReport(claims, employeeId)) {
      const buf = edits[c.claimId]
      if (buf && isDirty(c, buf) && !(await handleSave(c.claimId))) {
        setReportMessage(`⚠ Could not save your change to ${receiptsById[c.receiptId]?.fileName ?? c.claimId}; nothing was submitted.`)
        setSubmitting(null)
        return
      }
    }
    const result = await submitReport(employeeId)
    setReportMessage(
      result.success
        ? `✓ Submitted ${result.report.reportId}: ${result.report.claimCount} claim(s), ${formatTotals(result.report.totals)}. Your admin will approve or reject each one.`
        : `⚠ ${result.reason}`,
    )
    setSubmitting(null)
    await refresh()
  }

  // The employee's claims built but not yet submitted, i.e. what one click
  // on Submit would send.
  const ready = isAdmin ? [] : readyForReport(claims, employeeId)
  const myClaims = isAdmin ? claims : claims.filter((c) => sameEmployee(c.employeeId, employeeId))
  const myReports = isAdmin ? reports : reports.filter((r) => sameEmployee(r.employeeId, employeeId))
  const shown = isAdmin ? myClaims.filter(ADMIN_FILTERS.find((f) => f.id === filter)!.match) : myClaims
  const formatTotals = (totals: Record<string, number>) =>
    Object.entries(totals)
      .map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`)
      .join(' + ') || '—'

  async function handleExport(scope: ExportScope) {
    setExporting(scope)
    try {
      const result = await exportClaims(scope)
      setExportMessage(
        result.success ? `✓ Downloaded ${result.claimCount} claim(s) as ${result.fileName}` : `⚠ ${result.reason}`,
      )
    } catch (err) {
      setExportMessage(`⚠ Export failed: ${errorText(err)}`)
    } finally {
      setExporting(null)
    }
  }
  const approvedCount = claims.filter((c) => c.status === 'approved').length
  // A report's progress: how many of its claims the admin has decided.
  const reportProgress = (reportId: string) => {
    const inReport = claims.filter((c) => c.reportId === reportId)
    const approved = inReport.filter((c) => c.status === 'approved').length
    const rejected = inReport.filter((c) => c.status === 'rejected').length
    return { approved, rejected, waiting: inReport.filter((c) => c.status === 'submitted').length }
  }
  const exportOptions: { scope: ExportScope; label: string; count: number }[] = [
    { scope: 'approved', label: 'Approved', count: approvedCount },
    { scope: 'pending', label: 'Not approved', count: claims.length - approvedCount },
    { scope: 'all', label: 'All', count: claims.length },
  ]

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
          {isAdmin ? 'All claims' : 'My claims'} ({loaded ? myClaims.length : '…'})
        </p>
        {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-white/50">
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
            Download (XLSX)
          </span>
          <div className="inline-flex overflow-hidden rounded-lg border border-white/30">
            {exportOptions.map(({ scope, label, count }, i) => (
              <button
                key={scope}
                type="button"
                onClick={() => handleExport(scope)}
                disabled={exporting !== null || count === 0}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 ${i > 0 ? 'border-l border-white/30' : ''}`}
              >
                {exporting === scope && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />}
                {label}
                <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums text-white/70">{loaded ? count : '…'}</span>
              </button>
            ))}
          </div>
        </div>
        )}
      </div>
      {exportMessage && <p className="mt-2 text-xs text-white/60">{exportMessage}</p>}

      {loaded && (ready.length > 0 || myReports.length > 0 || reportMessage) && (
        <section className="mt-4 rounded-2xl border border-white/20 p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-white">
            <FolderCheck className="h-4 w-4" strokeWidth={1.75} />
            Expense reports
          </p>
          <p className="mt-0.5 text-xs text-white/50">
            {isAdmin
              ? 'What each employee submitted, and how much of it you have decided.'
              : 'Check each receipt below and correct anything that was read wrong, then submit them together in one click.'}
          </p>
          {ready.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/15 px-3 py-2.5 text-sm">
              <span className="text-white/80">
                <span className="font-medium text-white">{ready.length} claim(s)</span> ready to submit ·{' '}
                {formatTotals(totalsByCurrency(ready))}
              </span>
              <button
                type="button"
                disabled={submitting !== null}
                onClick={() => handleSubmitReport(employeeId)}
                title="Sends these claims to the admin; they can't be edited after this"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-60"
              >
                {submitting !== null ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                ) : (
                  <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                Submit for approval
              </button>
            </div>
          )}
          {reportMessage && <p className="mt-2 text-xs text-white/60">{reportMessage}</p>}
          {myReports.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-white/60">
              {myReports.map((r) => {
                const p = reportProgress(r.reportId)
                return (
                  <li key={r.reportId} className="flex flex-wrap gap-x-3">
                    <span className="font-medium text-white/80">{r.reportId}</span>
                    {isAdmin && <span>{r.employeeId}</span>}
                    <span>{r.claimCount} claim(s)</span>
                    <span>{formatTotals(r.totals)}</span>
                    <span>submitted {new Date(r.submittedAt).toLocaleString()}</span>
                    <span>
                      {p.approved} approved · {p.rejected} rejected · {p.waiting} waiting
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
      {isAdmin && loaded && (
        <div className="mt-4 flex flex-wrap gap-2">
          {ADMIN_FILTERS.map((f) => {
            const count = claims.filter(f.match).length
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f.id ? 'border-white bg-white text-black' : 'border-white/25 text-white/70 hover:border-white/60'
                }`}
              >
                {f.label}
                <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${filter === f.id ? 'bg-black/10' : 'bg-white/10'}`}>{count}</span>
              </button>
            )
          })}
        </div>
      )}
      {!loaded ? (
        <LoadingState error={loadError} />
      ) : shown.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
          <Receipt className="h-8 w-8 text-white/25" strokeWidth={1.5} />
          <p className="text-sm text-white/50">
            {isAdmin
              ? filter === 'submitted'
                ? 'Nothing is waiting for your approval.'
                : 'No claims here.'
              : 'No claims yet — upload receipts and click Extract all first.'}
          </p>
        </div>
      ) : (
        <ul className="mt-3 space-y-4">
          {shown.map((c) => {
            const buf = edits[c.claimId] ?? toBuffer(c)
            const receipt = receiptsById[c.receiptId]
            const StatusIcon =
              c.status === 'approved'
                ? CheckCircle2
                : c.status === 'rejected'
                  ? XCircle
                  : c.status === 'submitted'
                    ? Send
                    : c.status === 'review'
                      ? Clock
                      : FileEdit
            // Only the employee corrects a claim, and only before submitting it.
            const locked = isAdmin || !(c.status === 'draft' || c.status === 'review')
            return (
              <li key={c.claimId} className="rounded-2xl border border-white/15 p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium text-white">{receipt?.fileName ?? c.receiptId}</p>
                  <span
                    className={`inline-flex flex-none items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                      c.status === 'approved'
                        ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300'
                        : c.status === 'rejected'
                          ? 'border-red-400/50 bg-red-400/10 text-red-300'
                          : c.status === 'submitted'
                            ? 'border-sky-400/50 bg-sky-400/10 text-sky-300'
                            : 'border-white/30 text-white/80'
                    }`}
                  >
                    <StatusIcon className="h-3 w-3" strokeWidth={1.75} />
                    {c.status === 'submitted' ? 'waiting for approval' : c.status === 'draft' || c.status === 'review' ? (isAdmin ? 'not submitted' : `${c.status} · to check`) : c.status}
                  </span>
                </div>
                {isAdmin && c.employeeId && (
                  <p className="mt-0.5 text-xs text-white/50">
                    Claimed by {c.employeeId}
                    {c.reportId && ` · report ${c.reportId}`}
                  </p>
                )}

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

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <label className="text-xs text-white/50">
                    Vendor
                    <input
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
                      value={buf.vendor}
                      disabled={locked}
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
                      disabled={locked}
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
                      disabled={locked}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, currency: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-white/50">
                    Date
                    <input
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
                      value={buf.date}
                      placeholder="YYYY-MM-DD"
                      disabled={locked}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [c.claimId]: { ...buf, date: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="text-xs text-white/50">
                    Category
                    <select
                      className="mt-0.5 w-full rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40 disabled:opacity-40"
                      value={buf.category}
                      disabled={locked}
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

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-xs">
                  {(() => {
                    const badge = c.policyResult ? POLICY_BADGE[c.policyResult] : null
                    if (!badge) return <span className={`${BADGE} ${TRIP_BADGE.none}`}>Policy not checked</span>
                    const { Icon } = badge
                    return (
                      <span
                        className={`${BADGE} ${badge.cls}`}
                        title={`Re-checked against the policy whenever amount, currency or category is saved${c.policyReasonCode ? ` (${c.policyReasonCode})` : ''}`}
                      >
                        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                        {badge.label}
                        {c.policyReasonCode && c.policyResult !== 'PASS' && <span className="font-normal opacity-90">· {readableCode(c.policyReasonCode)}</span>}
                      </span>
                    )
                  })()}
                  {!c.travelRequestId ? (
                    <span className={`${BADGE} ${TRIP_BADGE.none}`}>
                      <Plane className="h-3.5 w-3.5" strokeWidth={1.75} />
                      No trip linked
                    </span>
                  ) : c.travelMatch === 'REVIEW' ? (
                    <span className={`${BADGE} ${TRIP_BADGE.suggested}`} title="Close to a trip but not certain; check it">
                      <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
                      Suggested: {tripLabel(c.travelRequestId)}
                    </span>
                  ) : (
                    <span className={`${BADGE} ${TRIP_BADGE.linked}`}>
                      <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                      Trip matched: {tripLabel(c.travelRequestId)}
                    </span>
                  )}
                  {c.employeeId && (
                    <span className={`${BADGE} ${TRIP_BADGE.none}`}>
                      <User className="h-3.5 w-3.5" strokeWidth={1.75} />
                      {c.employeeId}
                    </span>
                  )}
                </div>

                {c.lineItems.length > 0 && (
                  <table className="mt-3 w-full text-xs text-white/60">
                    <tbody>
                      {c.lineItems.map((item, i) => (
                        <tr key={i} className="border-t border-white/5">
                          <td className="py-1 pr-2 text-white/80">{item.description}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">
                            {item.amount === null ? '—' : item.amount.toFixed(2)}
                          </td>
                          <td
                            className="py-1 text-right"
                            title={item.inherited ? "No category in this line's text; uses the receipt's" : undefined}
                          >
                            {item.category}
                            {item.inherited && <span className="text-white/30">*</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {!locked && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSave(c.claimId)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
                    >
                      <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Save changes
                    </button>
                    {removing === c.claimId ? (
                      <span className="inline-flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-white/70">Remove this receipt from your claims?</span>
                        <button
                          type="button"
                          onClick={() => handleWithdraw(c.claimId)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-400 bg-red-500/80 px-3 py-1.5 font-medium text-white transition-colors hover:bg-red-500"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Yes, remove
                        </button>
                        <button type="button" onClick={() => setRemoving(null)} className="text-white/50 hover:text-white">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRemoving(c.claimId)}
                        title="For a duplicate or a personal expense: removes it before you submit"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/60 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-400/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Remove
                      </button>
                    )}
                    {message[c.claimId] && <span className="text-xs text-white/50">{message[c.claimId]}</span>}
                  </div>
                )}
                {!isAdmin && c.status === 'submitted' && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-sky-300">
                    <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Submitted in {c.reportId} · waiting for the admin's approval
                  </p>
                )}
                {isAdmin && (c.status === 'draft' || c.status === 'review') && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-white/50">
                    <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
                    The employee hasn't checked and submitted this yet.
                  </p>
                )}
                {isAdmin && c.status === 'submitted' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleApprove(c)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white/90"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Approve
                    </button>
                    {rejecting[c.claimId] === undefined ? (
                      <button
                        type="button"
                        onClick={() => setRejecting((r) => ({ ...r, [c.claimId]: '' }))}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/60 px-3.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-400/10"
                      >
                        <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Reject
                      </button>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <input
                          autoFocus
                          className="w-56 rounded-md border border-red-400/60 bg-black px-2 py-1.5 text-xs text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-red-400/50"
                          placeholder="Reason (optional), e.g. personal expense"
                          value={rejecting[c.claimId]}
                          onChange={(e) => setRejecting((r) => ({ ...r, [c.claimId]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleReject(c.claimId)
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => handleReject(c.claimId)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-400 bg-red-500/80 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                        >
                          <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Confirm reject
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setRejecting((r) => {
                              const next = { ...r }
                              delete next[c.claimId]
                              return next
                            })
                          }
                          className="text-xs text-white/50 hover:text-white"
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                    {message[c.claimId] && (
                      <span className="text-xs text-white/50">{message[c.claimId]}</span>
                    )}
                  </div>
                )}
                {c.status === 'rejected' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <p className="flex items-center gap-1.5 font-semibold text-red-300">
                      <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Rejected {c.rejectedAt && new Date(c.rejectedAt).toLocaleString()}
                      {c.rejectionReason && <span className="font-normal text-red-200/90">· {c.rejectionReason}</span>}
                    </p>
                    {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleReopen(c.claimId)}
                      className="inline-flex items-center gap-1 rounded-md border border-white/30 px-2.5 py-1 font-medium text-white transition-colors hover:border-white hover:bg-white/5"
                    >
                      <RotateCcw className="h-3 w-3" strokeWidth={2} />
                      Send back to employee
                    </button>
                    )}
                    {message[c.claimId] && <span className="text-white/50">{message[c.claimId]}</span>}
                  </div>
                )}
                {c.status === 'approved' && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-white">
                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Approved {c.approvedAt && new Date(c.approvedAt).toLocaleString()}
                    {c.reportId && ` · report ${c.reportId}`}
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
