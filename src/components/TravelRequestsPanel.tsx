import { useEffect, useState } from 'react'
import { Plane, CircleAlert, MapPin, CalendarPlus, CheckCircle2, Clock, XCircle } from 'lucide-react'
import * as repo from '../modules/storage/repository'
import { generateId } from '../utils/id'
import { LoadingState, errorText } from './LoadingState'
import type { TravelRequestRecord } from '../types/records'

const STATUS_ICONS: Record<TravelRequestRecord['approvalStatus'], typeof CheckCircle2> = {
  approved: CheckCircle2,
  pending: Clock,
  rejected: XCircle,
}

export function TravelRequestsPanel() {
  const [requests, setRequests] = useState<TravelRequestRecord[]>([])
  const [employeeId, setEmployeeId] = useState('')
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

  useEffect(() => {
    refresh()
  }, [])

  async function addRequest() {
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
      employeeId: employeeId.trim(),
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

  return (
    <div>
      <section className="rounded-2xl border border-white/15 p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <CalendarPlus className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <p className="text-sm font-semibold text-white">Add an approved trip</p>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/10 pt-4">
          <div>
            <label className="block text-xs text-white/50">Employee ID</label>
            <input
              className="w-32 rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
              placeholder="EMP001"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            />
          </div>
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
          <button
            type="button"
            onClick={addRequest}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-sm font-medium text-black transition-colors hover:bg-white/90"
          >
            <Plane className="h-4 w-4" strokeWidth={1.75} />
            Add request
          </button>
        </div>
        {dateError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-white">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
            {dateError}
          </p>
        )}
      </section>

      <div className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
          Travel requests ({loaded ? requests.length : '…'})
        </p>
        {!loaded ? (
          <LoadingState error={loadError} />
        ) : requests.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
            <Plane className="h-8 w-8 text-white/25" strokeWidth={1.5} />
            <p className="text-sm text-white/50">No travel requests yet.</p>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {requests.map((r) => {
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
                  <span className="inline-flex flex-none items-center gap-1 rounded-full border border-white/25 px-2.5 py-1 text-xs font-medium text-white/80">
                    <StatusIcon className="h-3 w-3" strokeWidth={1.75} />
                    {r.approvalStatus}
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
