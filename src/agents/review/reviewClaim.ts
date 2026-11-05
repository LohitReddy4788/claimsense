import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { evaluatePolicy } from '../../modules/policy/policyEngine'
import type { ExpenseCategory } from '../../types/category'
import type { ClaimRecord } from '../../types/records'

export type ClaimEditableFields = Pick<ClaimRecord, 'vendor' | 'amount' | 'currency' | 'date' | 'category'>

const DEFAULT_POLICY_SETTINGS = { id: 'default' as const, baseCurrency: 'USD', rates: {} }

/** Applies a human correction to a claim's extracted fields, then re-runs
 * the Policy Engine whenever the edit touched something it depends on
 * (amount, currency or category). Found in the pre-submission audit: the
 * policy result used to stay as originally extracted, so correcting a
 * misread $50 meal to $500 still showed — and exported — PASS against a
 * $75 limit. A re-check that turns up a problem moves a draft back to
 * review, and both the edit and the new result go on the audit trail.
 * Travel reconciliation is not re-run: it depends on the date and
 * destination, and its link is shown alongside for the reviewer to judge.
 * Refuses to edit an approved claim — once a human has signed off, its
 * values are what was submitted, and changing them would rewrite history. */
export async function editClaim(claimId: string, patch: Partial<ClaimEditableFields>): Promise<void> {
  const before = await repo.getClaim(claimId)
  if (!before) throw new Error(`No claim found with id ${claimId}.`)
  if (before.status === 'approved') throw new Error('This claim is already approved and can no longer be edited.')

  await repo.updateClaim(claimId, patch)
  const fields = Object.entries(patch)
    .map(([key, value]) => `${key}: ${value ?? '—'}`)
    .join(', ')
  await appendAuditEntry(claimId, 'CLAIM_EDITED', fields || '(no fields changed)')

  if (!('amount' in patch || 'currency' in patch || 'category' in patch)) return

  const after = { ...before, ...patch }
  const [policies, settings] = await Promise.all([repo.listPolicies(), repo.getPolicySettings()])
  const policy = evaluatePolicy(
    { vendor: after.vendor, amount: after.amount, currency: after.currency, date: after.date, lineItems: [] },
    after.category as ExpenseCategory,
    policies,
    settings ?? DEFAULT_POLICY_SETTINGS,
  )
  if (policy.status === before.policyResult && policy.reasonCode === before.policyReasonCode) return

  await repo.updateClaim(claimId, {
    policyResult: policy.status,
    policyReasonCode: policy.reasonCode,
    // Only ever tightens: a re-check that now passes leaves a review claim
    // in review, since it may be flagged for other reasons (a duplicate,
    // inconsistent line items) the edit didn't address.
    ...(policy.status !== 'PASS' && before.status === 'draft' ? { status: 'review' as const } : {}),
  })
  await appendAuditEntry(
    claimId,
    'POLICY_REEVALUATED',
    `${before.policyResult ?? '—'} → ${policy.status}${policy.reasonCode ? ` (${policy.reasonCode})` : ''}: ${policy.message}`,
  )
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
