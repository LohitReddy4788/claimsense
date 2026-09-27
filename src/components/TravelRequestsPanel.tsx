import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { generateId } from '../utils/id'
import type { TravelRequestRecord } from '../types/records'

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
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">Employee ID</label>
          <input
            className="w-32 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="EMP001"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">Destination</label>
          <input
            className="w-40 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="Singapore"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">Start date</label>
          <input
            type="date"
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">End date</label>
          <input
            type="date"
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">Status</label>
          <select
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
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
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Add request
        </button>
      </div>
      {dateError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{dateError}</p>}

      <p className="mt-6 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Travel requests ({requests.length})
      </p>
      {requests.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">No travel requests yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
          {requests.map((r) => (
            <li key={r.requestId} className="flex items-center justify-between py-2 text-sm">
              <div>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">
                  {r.employeeId} → {r.destination}
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {r.startDate} to {r.endDate}
                </p>
              </div>
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {r.approvalStatus}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
