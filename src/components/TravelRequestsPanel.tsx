import { useState } from 'react'
import { useLiveRefresh } from '../hooks/useLiveRefresh'
import { Plane, CircleAlert, MapPin, CalendarPlus, CheckCircle2, Clock, XCircle, Check, X, Loader2 } from 'lucide-react'
import * as repo from '../modules/storage/repository'
import { generateId } from '../utils/id'
import { requestTravel, decideTravelRequest } from '../agents/travel/decideTravelRequest'
import { LoadingState, errorText } from './LoadingState'
import type { TravelRequestRecord } from '../types/records'

const STATUS_ICONS: Record<TravelRequestRecord['approvalStatus'], typeof CheckCircle2> = {
  approved: CheckCircle2,
  pending: Clock,
  rejected: XCircle,
}

const STATUS_STYLE: Record<TravelRequestRecord['approvalStatus'], string> = {
  approved: 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300',
  pending: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
  rejected: 'border-red-400/50 bg-red-400/10 text-red-300',
}

interface TravelRequestsPanelProps {
  /** Employee: request trips (pending until decided) and see their own.
   * Admin: approve or reject everyone's, or add an approved trip directly. */
  portal: 'employee' | 'admin'
  /** The signed-in employee (employee portal only). */
  employeeId?: string
  /** Whether this page is the one on screen; while it is, the list keeps
   * itself current (new requests from the employee, decisions by the admin). */
  active: boolean
}

export function TravelRequestsPanel({ portal, employeeId: me = '', active }: TravelRequestsPanelProps) {
  const isAdmin = portal === 'admin'
  const [requests, setRequests] = useState<TravelRequestRecord[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  // The trip being approved or rejected (re-matching receipts can take a moment).
  const [deciding, setDeciding] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [approvalStatus, setApprovalStatus] =
    useState<TravelRequestRecord['approvalStatus']>('approved')
  const [dateError, setDateError] = useState<string | null>(null)

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function refresh() {
    try {
      const all = await repo.listTravelRequests()
      setRequests(all)
      setLoaded(true)
      setLoadError(null)
    } catch (err) {
      console.error('TravelRequestsPanel refresh failed:', err)
      setLoadError(errorText(err))
    }
  }

  useLiveRefresh(active, refresh)

  async function decide(r: TravelRequestRecord, decision: 'approved' | 'rejected') {
    if (deciding) return
    setDeciding(r.requestId)
    setNotice(null)
    try {
      const result = await decideTravelRequest(r.requestId, decision)
      setNotice(
        result.success
          ? `${r.employeeId}'s trip to ${r.destination} ${decision}.${
              result.rematched
                ? decision === 'approved'
                  ? ` ${result.rematched} of their receipt(s) now linked to it.`
                  : ` ${result.rematched} of their receipt(s) no longer linked to it.`
                : ''
            }`
          : result.reason,
      )
    } catch (err) {
      setNotice(`Could not update the trip: ${errorText(err)}`)
    }
    await refresh()
    setDeciding(null)
  }

  async function addRequest() {
    if (!isAdmin) {
      const result = await requestTravel({ employeeId: me, destination, startDate, endDate })
      if (!result.success) {
        setDateError(result.reason)
        return
      }
      setDateError(null)
      setNotice(`Trip to ${result.request.destination} requested. It's pending until your admin approves it.`)
      setDestination('')
      setStartDate('')
      setEndDate('')
      await refresh()
      return
    }
    if (!employeeId.trim() || !destination.trim() || !startDate || !endDate) return
    // Found live: nothing stopped an end date before the start date. Not a
    // crash — reconcileTravel's date-range check (receiptDate >= start &&
    // receiptDate <= end) just silently can never be satisfied by an
    // inverted range, so the trip would never match any receipt with no
    // error anywhere explaining why. Reject it here instead.
    if (endDate < startDate) {
      setDateError('End date must be on or after the start date.')
      return
    }
    setDateError(null)
    const record: TravelRequestRecord = {
      requestId: generateId('trv'),
      employeeId: employeeId.trim().toUpperCase(),
      destination: destination.trim(),
      startDate,
      endDate,
      approvalStatus,
    }
    await repo.addTravelRequest(record)
    setEmployeeId('')
    setDestination('')
    setStartDate('')
    setEndDate('')
    await refresh()
  }

  const visible = isAdmin
    ? [...requests].sort((a, b) => Number(b.approvalStatus === 'pending') - Number(a.approvalStatus === 'pending'))
    : requests.filter((r) => r.employeeId.trim().toUpperCase() === me.trim().toUpperCase())
  const pendingCount = requests.filter((r) => r.approvalStatus === 'pending').length

  return (
    <div>
      <section className="rounded-2xl border border-white/15 p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <CalendarPlus className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{isAdmin ? 'Add a trip directly' : 'Request a trip'}</p>
            <p className="text-xs text-white/50">
              {isAdmin
                ? 'Employees request trips themselves; use this only to record one for them.'
                : 'Your admin approves it. Receipts from an approved trip are linked to it automatically.'}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/10 pt-4">
          {isAdmin && (
          <div>
            <label className="block text-xs text-white/50">Employee ID</label>
            <input
              className="w-32 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              placeholder="EMP001"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            />
          </div>
          )}
          <div>
            <label className="block text-xs text-white/50">Destination</label>
            <input
              className="w-40 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              placeholder="Singapore"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-white/50">Start date</label>
            <input
              type="date"
              className="rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-white/50">End date</label>
            <input
              type="date"
              className="rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          {isAdmin && (
          <div>
            <label className="block text-xs text-white/50">Status</label>
            <select
              className="rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              value={approvalStatus}
              onChange={(e) =>
                setApprovalStatus(e.target.value as TravelRequestRecord['approvalStatus'])
              }
            >
              <option value="approved">approved</option>
              <option value="pending">pending</option>
              <option value="rejected">rejected</option>
            </select>
          </div>
          )}
          <button
            type="button"
            onClick={addRequest}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
          >
            <Plane className="h-4 w-4" strokeWidth={1.75} />
            {isAdmin ? 'Add trip' : 'Send request'}
          </button>
        </div>
        {notice && <p className="mt-2 text-xs text-white/70">{notice}</p>}
        {dateError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-white">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
            {dateError}
          </p>
        )}
      </section>

      <div className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
          {isAdmin ? 'Travel requests' : 'My travel requests'} ({loaded ? visible.length : '…'})
          {isAdmin && pendingCount > 0 && <span className="ml-2 normal-case text-amber-300">· {pendingCount} waiting for you</span>}
        </p>
        {!loaded ? (
          <LoadingState error={loadError} />
        ) : visible.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
            <Plane className="h-8 w-8 text-white/25" strokeWidth={1.5} />
            <p className="text-sm text-white/50">No travel requests yet.</p>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {visible.map((r) => {
              const StatusIcon = STATUS_ICONS[r.approvalStatus]
              return (
                <li
                  key={r.requestId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/15 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-white/20">
                      <MapPin className="h-4 w-4 text-white/60" strokeWidth={1.75} />
                    </div>
                    <div>
                      <p className="font-medium text-white">
                        {r.employeeId} → {r.destination}
                      </p>
                      <p className="text-xs text-white/50">
                        {r.startDate} to {r.endDate}
                      </p>
                    </div>
                  </div>
                  <span className="flex flex-none flex-wrap items-center justify-end gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[r.approvalStatus]}`}>
                      <StatusIcon className="h-3 w-3" strokeWidth={1.75} />
                      {r.approvalStatus}
                    </span>
                    {deciding === r.requestId && (
                      <span className="inline-flex items-center gap-1 text-xs text-white/60">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                        Updating and re-matching receipts…
                      </span>
                    )}
                    {isAdmin && r.approvalStatus !== 'approved' && (
                      <button
                        type="button"
                        onClick={() => decide(r, 'approved')}
                        disabled={deciding !== null}
                        className="inline-flex items-center gap-1 rounded-md border border-white bg-white px-2.5 py-1 text-xs font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-40"
                      >
                        <Check className="h-3 w-3" strokeWidth={2.25} />
                        Approve
                      </button>
                    )}
                    {isAdmin && r.approvalStatus !== 'rejected' && (
                      <button
                        type="button"
                        onClick={() => decide(r, 'rejected')}
                        disabled={deciding !== null}
                        className="inline-flex items-center gap-1 rounded-md border border-red-400/60 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-400/10 disabled:opacity-40"
                      >
                        <X className="h-3 w-3" strokeWidth={2.25} />
                        Reject
                      </button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
