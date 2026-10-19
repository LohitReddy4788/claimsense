import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import type { ClaimRecord } from '../../types/records'

export type ClaimEditableFields = Pick<ClaimRecord, 'vendor' | 'amount' | 'currency' | 'date' | 'category'>

/** Applies a human correction to a claim's extracted fields. Does not
 * re-run policy/reconciliation against the edit — Phase 11's job is
 * capturing the employee's correction and gating submission on it, not
 * re-deriving downstream results (that would be a bigger, separate
 * feature: "re-evaluate on edit"). An edited claim still shows its
 * original policy/reconciliation results alongside the correction so
 * nothing is silently hidden. */
export async function editClaim(claimId: string, patch: Partial<ClaimEditableFields>): Promise<void> {
  await repo.updateClaim(claimId, patch)
  const fields = Object.entries(patch)
    .map(([key, value]) => `${key}: ${value ?? '—'}`)
    .join(', ')
  await appendAuditEntry(claimId, 'CLAIM_EDITED', fields || '(no fields changed)')
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
