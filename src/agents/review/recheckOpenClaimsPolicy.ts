import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { evaluateClaimPolicy } from '../../modules/policy/policyEngine'
import type { ExpenseCategory } from '../../types/category'
import type { ClaimRecord } from '../../types/records'

const DEFAULT_POLICY_SETTINGS = { id: 'default' as const, baseCurrency: 'USD', rates: {} }

/** Re-runs the Policy Engine on every claim the employee hasn't submitted
 * yet, after the admin changes a limit or a currency rate.
 *
 * Found in testing: claims are checked when a receipt is read. If the admin
 * added the policy afterwards (or a rate a claim was missing), those claims
 * kept showing "No policy defined" or "Currency unsupported" even though
 * the rule now existed. Trips already re-match this way when approved
 * (rematchOpenClaims).
 *
 * Submitted and decided claims are left alone. They were judged against the
 * rules in force when the employee submitted them. As with an edit, a
 * re-check that finds a problem moves a draft to review, but it never clears
 * a review flag, which may have other causes (a duplicate, say). Returns how
 * many claims changed. */
async function recheckOnce(): Promise<number> {
  const [claims, policies, settings] = await Promise.all([
    repo.listClaims(),
    repo.listPolicies(),
    repo.getPolicySettings(),
  ])
  let changed = 0
  for (const c of claims) {
    if (c.status !== 'draft' && c.status !== 'review') continue
    const result = evaluateClaimPolicy(
      { vendor: c.vendor, amount: c.amount, currency: c.currency, date: c.date, lineItems: [] },
      c.category as ExpenseCategory,
      c.lineItems,
      policies,
      settings ?? DEFAULT_POLICY_SETTINGS,
    )
    if (result.status === c.policyResult && result.reasonCode === c.policyReasonCode) continue
    const updates: Partial<ClaimRecord> = { policyResult: result.status, policyReasonCode: result.reasonCode }
    if (result.status !== 'PASS' && c.status === 'draft') updates.status = 'review'
    await repo.updateClaim(c.claimId, updates)
    await appendAuditEntry(
      c.claimId,
      'POLICY_REEVALUATED',
      `policy changed: ${c.policyResult ?? '—'} → ${result.status}${result.reasonCode ? ` (${result.reasonCode})` : ''}: ${result.message}`,
    )
    changed++
  }
  return changed
}

// Several quick Adds (a policy PDF's rows) each ask for a re-check. Run one
// at a time, and fold any that arrive mid-run into a single extra pass, so
// two passes never both write the same change and log it twice.
let running: Promise<number> | null = null
let again = false

export function recheckOpenClaimsPolicy(): Promise<number> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    let total = 0
    do {
      again = false
      total += await recheckOnce()
    } while (again)
    return total
  })().finally(() => {
    running = null
  })
  return running
}
