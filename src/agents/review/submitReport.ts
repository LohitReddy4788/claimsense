import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { generateId } from '../../utils/id'
import type { ClaimRecord, ClaimReportRecord } from '../../types/records'

export type SubmitReportResult =
  | { success: true; report: ClaimReportRecord }
  | { success: false; reason: string }

const sameEmployee = (a: string | null, b: string) => !!a && a.trim().toUpperCase() === b.trim().toUpperCase()

/** Approved claims an employee hasn't submitted in a report yet. */
export function readyForReport(claims: ClaimRecord[], employeeId: string): ClaimRecord[] {
  return claims.filter((c) => c.status === 'approved' && c.reportId === null && sameEmployee(c.employeeId, employeeId))
}

/** Per-currency totals, rounded to cents. A claim with no amount adds
 * nothing (it can only have been approved by a human who saw that). */
export function totalsByCurrency(claims: ClaimRecord[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const c of claims) {
    if (c.amount === null) continue
    const currency = (c.currency ?? '?').toUpperCase()
    totals[currency] = Math.round(((totals[currency] ?? 0) + c.amount) * 100) / 100
  }
  return totals
}

/** Review & Submit Agent, final step: bundles an employee's approved
 * receipts into one submitted expense claim, as the brief describes ("a
 * folder of receipts into a submitted expense claim"). Each receipt is
 * still reviewed and approved on its own first; this is the one click that
 * submits them together. Added in the pre-submission audit, when every
 * receipt had been its own separate claim. A claim can be in only one
 * report (enforced in the same transaction that writes it). */
export async function submitReport(employeeId: string): Promise<SubmitReportResult> {
  const who = employeeId.trim().toUpperCase()
  if (!who) return { success: false, reason: 'No employee given.' }

  const claims = readyForReport(await repo.listClaims(), who)
  if (claims.length === 0) {
    return { success: false, reason: `${who} has no approved claims waiting to be submitted.` }
  }

  const report: ClaimReportRecord = {
    reportId: generateId('rpt'),
    employeeId: who,
    claimCount: claims.length,
    totals: totalsByCurrency(claims),
    submittedAt: new Date().toISOString(),
  }
  try {
    await repo.submitReport(report, claims.map((c) => c.claimId))
  } catch (err) {
    return { success: false, reason: err instanceof Error ? err.message : String(err) }
  }

  const totals = Object.entries(report.totals)
    .map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`)
    .join(' + ')
  await appendAuditEntry(
    report.reportId,
    'REPORT_SUBMITTED',
    `${who}: ${claims.length} claim(s), ${totals || 'no amounts'} — ${claims.map((c) => c.claimId).join(', ')}`,
  )
  return { success: true, report }
}
