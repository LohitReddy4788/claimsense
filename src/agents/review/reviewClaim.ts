import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { evaluateClaimPolicy } from '../../modules/policy/policyEngine'
import { reconcileTravel } from '../travel/reconcileTravel'
import type { ExpenseCategory } from '../../types/category'
import type { ClaimRecord } from '../../types/records'

export type ClaimEditableFields = Pick<ClaimRecord, 'vendor' | 'amount' | 'currency' | 'date' | 'category'>

const DEFAULT_POLICY_SETTINGS = { id: 'default' as const, baseCurrency: 'USD', rates: {} }

/** Applies a human correction to a claim's extracted fields, then re-runs
 * whatever depended on them, so what's approved and exported matches what
 * the reviewer sees:
 * - the Policy Engine, when amount, currency or category changed (found in
 *   the pre-submission audit: correcting a misread $50 meal to $500 still
 *   showed, and exported, PASS against a $75 limit). Line items whose
 *   category was inherited from the receipt follow a category change.
 * - the Travel Reconciler, when the date or vendor changed (a date OCR
 *   misread or missed is exactly what a reviewer fixes). Skipped for
 *   claims created before the employee was stored.
 * A re-check that turns up a problem moves a draft to review; it never
 * clears a review flag, which may have other causes (a duplicate, say).
 * Each change of result goes on the audit trail. Refuses to edit an
 * approved claim: once a human has signed off, its values are what was
 * submitted, and changing them would rewrite history. */
export async function editClaim(claimId: string, patch: Partial<ClaimEditableFields>): Promise<void> {
  const before = await repo.getClaim(claimId)
  if (!before) throw new Error(`No claim found with id ${claimId}.`)
  if (before.status === 'approved') throw new Error('This claim is already approved and can no longer be edited.')
  if (before.status === 'rejected') throw new Error('This claim was rejected; reopen it before editing.')

  await repo.updateClaim(claimId, patch)
  const fields = Object.entries(patch)
    .map(([key, value]) => `${key}: ${value ?? '—'}`)
    .join(', ')
  await appendAuditEntry(claimId, 'CLAIM_EDITED', fields || '(no fields changed)')

  const after = { ...before, ...patch }
  const data = { vendor: after.vendor, amount: after.amount, currency: after.currency, date: after.date, lineItems: [] }
  const updates: Partial<ClaimRecord> = {}
  let flagged = false

  if ('amount' in patch || 'currency' in patch || 'category' in patch) {
    const category = after.category as ExpenseCategory
    const lineItems = after.lineItems.map((item) => (item.inherited ? { ...item, category } : item))
    if ('category' in patch) updates.lineItems = lineItems
    const [policies, settings] = await Promise.all([repo.listPolicies(), repo.getPolicySettings()])
    const policy = evaluateClaimPolicy(data, category, lineItems, policies, settings ?? DEFAULT_POLICY_SETTINGS)
    if (policy.status !== before.policyResult || policy.reasonCode !== before.policyReasonCode) {
      updates.policyResult = policy.status
      updates.policyReasonCode = policy.reasonCode
      await appendAuditEntry(
        claimId,
        'POLICY_REEVALUATED',
        `${before.policyResult ?? '—'} → ${policy.status}${policy.reasonCode ? ` (${policy.reasonCode})` : ''}: ${policy.message}`,
      )
    }
    flagged ||= policy.status !== 'PASS'
  }

  if (('date' in patch || 'vendor' in patch) && before.employeeId) {
    const match = reconcileTravel(
      { ...data, lineItems: after.lineItems },
      before.employeeId,
      await repo.listTravelRequests(),
    )
    if (match.travelRequestId !== before.travelRequestId || match.status !== before.travelMatch) {
      updates.travelRequestId = match.travelRequestId
      updates.travelMatch = match.status
      await appendAuditEntry(
        claimId,
        'TRAVEL_REMATCHED',
        `${before.travelMatch ?? '—'} → ${match.status}${match.travelRequestId ? ` (${match.travelRequestId})` : ''}: ${match.reason}`,
      )
    }
    flagged ||= match.status === 'REVIEW'
  }

  if (flagged && before.status === 'draft') updates.status = 'review'
  if (Object.keys(updates).length > 0) await repo.updateClaim(claimId, updates)
}

export type ApproveResult =
  | { success: true; claim: ClaimRecord }
  | { success: false; reason: string }

/** Review & Submit Agent — the human-in-the-loop gate. Submission is only
 * possible through this explicit action; nothing else in the pipeline
 * ever sets a claim to 'approved'. Refuses to approve a claim that's
 * already approved (no silent re-approval / no way to "approve" twice and
 * confuse an audit trail once Phase 12 builds one) or one that doesn't
 * exist. Does NOT refuse to approve a claim still flagged 'review' — a
 * human looking at the screen might correctly determine a flagged claim
 * is actually fine (e.g. a false-positive duplicate); the gate is "a
 * human saw this," not "the pipeline was 100% confident." */
export async function approveClaim(claimId: string): Promise<ApproveResult> {
  const claim = await repo.getClaim(claimId)
  if (!claim) {
    return { success: false, reason: `No claim found with id ${claimId}.` }
  }
  if (claim.status === 'approved') {
    return { success: false, reason: 'This claim is already approved.' }
  }
  if (claim.status === 'rejected') {
    return { success: false, reason: 'This claim was rejected; reopen it before approving.' }
  }

  const approvedAt = new Date().toISOString()
  await repo.updateClaim(claimId, { status: 'approved', approvedAt })
  const updated = await repo.getClaim(claimId)
  // getClaim right after update should never be undefined — the
  // record we just successfully updated by its own primary key — but
  // treat it as a real failure rather than a non-null assertion if it
  // somehow is, since callers depend on getting a real ClaimRecord back.
  if (!updated) {
    return { success: false, reason: 'Claim was updated but could not be re-read afterward.' }
  }
  await appendAuditEntry(claimId, 'CLAIM_APPROVED', `approved at ${approvedAt}`)
  return { success: true, claim: updated }
}

/** The reviewer's other decision: this claim won't be paid. It stays in
 * the app (and in exports of claims not approved) with the reason, and
 * the decision goes on the audit trail. An approved claim can't be
 * rejected here, since it may already be in a submitted report. */
export async function rejectClaim(claimId: string, reason: string): Promise<ApproveResult> {
  const claim = await repo.getClaim(claimId)
  if (!claim) return { success: false, reason: `No claim found with id ${claimId}.` }
  if (claim.status === 'approved') return { success: false, reason: 'This claim is already approved.' }
  if (claim.status === 'rejected') return { success: false, reason: 'This claim is already rejected.' }

  const rejectedAt = new Date().toISOString()
  const why = reason.trim() || null
  await repo.updateClaim(claimId, { status: 'rejected', rejectedAt, rejectionReason: why })
  const updated = await repo.getClaim(claimId)
  if (!updated) return { success: false, reason: 'Claim was updated but could not be re-read afterward.' }
  await appendAuditEntry(claimId, 'CLAIM_REJECTED', `rejected at ${rejectedAt}${why ? `: ${why}` : ''}`)
  return { success: true, claim: updated }
}

/** Undoes a rejection, back to review, so a mistaken click isn't final. */
export async function reopenClaim(claimId: string): Promise<ApproveResult> {
  const claim = await repo.getClaim(claimId)
  if (!claim) return { success: false, reason: `No claim found with id ${claimId}.` }
  if (claim.status !== 'rejected') return { success: false, reason: 'Only a rejected claim can be reopened.' }

  await repo.updateClaim(claimId, { status: 'review', rejectedAt: null, rejectionReason: null })
  const updated = await repo.getClaim(claimId)
  if (!updated) return { success: false, reason: 'Claim was updated but could not be re-read afterward.' }
  await appendAuditEntry(claimId, 'CLAIM_REOPENED', 'rejection undone; back to review')
  return { success: true, claim: updated }
}
