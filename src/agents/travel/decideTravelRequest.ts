import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { generateId } from '../../utils/id'
import { reconcileTravel } from './reconcileTravel'
import type { TravelRequestRecord } from '../../types/records'

export type TravelResult = { success: true; request: TravelRequestRecord; rematched: number } | { success: false; reason: string }

/** An employee asks for a trip; it waits as pending until an admin decides. */
export async function requestTravel(input: {
  employeeId: string
  destination: string
  startDate: string
  endDate: string
}): Promise<TravelResult> {
  const employeeId = input.employeeId.trim().toUpperCase()
  const destination = input.destination.trim()
  if (!employeeId || !destination || !input.startDate || !input.endDate) {
    return { success: false, reason: 'Fill in the destination and both dates.' }
  }
  if (input.endDate < input.startDate) return { success: false, reason: 'End date must be on or after the start date.' }
  const request: TravelRequestRecord = {
    requestId: generateId('trv'),
    employeeId,
    destination,
    startDate: input.startDate,
    endDate: input.endDate,
    approvalStatus: 'pending',
  }
  await repo.addTravelRequest(request)
  await appendAuditEntry(request.requestId, 'TRAVEL_REQUESTED', `${employeeId}: ${destination}, ${request.startDate} to ${request.endDate}`)
  return { success: true, request, rematched: 0 }
}

const sameEmployee = (a: string | null | undefined, b: string) => !!a && a.trim().toUpperCase() === b.trim().toUpperCase()

/** Re-runs the Travel Reconciler for an employee's claims that are still
 * open (not yet submitted). Receipts are matched when they're extracted,
 * so a trip approved afterwards would otherwise never be linked to them.
 * Returns how many claims changed. */
export async function rematchOpenClaims(employeeId: string): Promise<number> {
  const [claims, trips] = await Promise.all([repo.listClaims(), repo.listTravelRequests()])
  let changed = 0
  for (const c of claims) {
    if (!sameEmployee(c.employeeId, employeeId)) continue
    if (c.status !== 'draft' && c.status !== 'review') continue
    const match = reconcileTravel(
      {
        vendor: c.vendor,
        amount: c.amount,
        currency: c.currency,
        date: c.date,
        lineItems: c.lineItems.map((i) => ({ description: i.description, amount: i.amount })),
      },
      employeeId,
      trips,
    )
    if (match.travelRequestId === c.travelRequestId && match.status === c.travelMatch) continue
    await repo.updateClaim(c.claimId, { travelRequestId: match.travelRequestId, travelMatch: match.status })
    await appendAuditEntry(
      c.claimId,
      'TRAVEL_REMATCHED',
      `${c.travelMatch ?? '—'} → ${match.status}${match.travelRequestId ? ` (${match.travelRequestId})` : ''}: ${match.reason}`,
    )
    changed++
  }
  return changed
}

/** The admin approves or rejects a trip. Approving one re-matches that
 * employee's open receipts against it. */
export async function decideTravelRequest(requestId: string, decision: 'approved' | 'rejected'): Promise<TravelResult> {
  const request = (await repo.listTravelRequests()).find((r) => r.requestId === requestId)
  if (!request) return { success: false, reason: `No travel request ${requestId}.` }
  if (request.approvalStatus === decision) return { success: false, reason: `This trip is already ${decision}.` }
  await repo.updateTravelRequest(requestId, { approvalStatus: decision })
  await appendAuditEntry(
    requestId,
    decision === 'approved' ? 'TRAVEL_APPROVED' : 'TRAVEL_REJECTED',
    `${request.employeeId}: ${request.destination}, ${request.startDate} to ${request.endDate}`,
  )
  const rematched = await rematchOpenClaims(request.employeeId)
  return { success: true, request: { ...request, approvalStatus: decision }, rematched }
}
