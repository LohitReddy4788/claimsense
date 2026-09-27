import { useEffect, useState } from 'react'
import { Plane, CircleAlert, MapPin, CalendarPlus, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { db } from '../modules/storage/db'
import { generateId } from '../utils/id'
import type { TravelRequestRecord } from '../types/records'

const STATUS_STYLES: Record<
  TravelRequestRecord['approvalStatus'],
  { icon: typeof CheckCircle2; className: string }
> = {
  approved: { icon: CheckCircle2, className: 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300' },
  pending: { icon: Clock, className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
  rejected: { icon: XCircle, className: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
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

  async function refresh() {
    const all = await db.travelRequests.toArray()
    setRequests(all)
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
    await db.travelRequests.add(record)
    setEmployeeId('')
    setDestination('')
    setStartDate('')
    setEndDate('')
    await refresh()
  }

  return (
    <div>
      <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/40">
            <CalendarPlus className="h-4 w-4 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Add an approved trip</p>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Employee ID</label>
            <input
              className="w-32 rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              placeholder="EMP001"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Destination</label>
            <input
              className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              placeholder="Singapore"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Start date</label>
            <input
              type="date"
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">End date</label>
            <input
              type="date"
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Status</label>
            <select
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700"
          >
            <Plane className="h-4 w-4" strokeWidth={2} />
            Add request
          </button>
        </div>
        {dateError && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
            {dateError}
          </p>
        )}
      </section>

      <div className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Travel requests ({requests.length})
        </p>
        {requests.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50/60 py-12 text-center dark:border-neutral-800 dark:bg-neutral-900/40">
            <Plane className="h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
            <p className="text-sm text-neutral-500 dark:text-neutral-400">No travel requests yet.</p>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {requests.map((r) => {
              const { icon: StatusIcon, className } = STATUS_STYLES[r.approvalStatus]
              return (
                <li
                  key={r.requestId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                      <MapPin className="h-4 w-4 text-neutral-500 dark:text-neutral-400" strokeWidth={2} />
                    </div>
                    <div>
                      <p className="font-medium text-neutral-900 dark:text-neutral-100">
                        {r.employeeId} → {r.destination}
                      </p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        {r.startDate} to {r.endDate}
                      </p>
                    </div>
                  </div>
                  <span className={`inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${className}`}>
                    <StatusIcon className="h-3 w-3" strokeWidth={2} />
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
