import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { generateId } from '../../utils/id'
import type { ClaimRecord, ClaimReportRecord } from '../../types/records'

export type SubmitReportResult =
  | { success: true; report: ClaimReportRecord }
  | { success: false; reason: string }

const sameEmployee = (a: string | null, b: string) => !!a && a.trim().toUpperCase() === b.trim().toUpperCase()

/** An employee's claims that are built but not yet submitted. */
export function readyForReport(claims: ClaimRecord[], employeeId: string): ClaimRecord[] {
  return claims.filter(
    (c) => (c.status === 'draft' || c.status === 'review') && c.reportId === null && sameEmployee(c.employeeId, employeeId),
  )
}

/** Per-currency totals, rounded to cents. A claim with no amount adds
 * nothing (the employee saw that when submitting). */
export function totalsByCurrency(claims: ClaimRecord[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const c of claims) {
    if (c.amount === null) continue
    const currency = (c.currency ?? '?').toUpperCase()
    totals[currency] = Math.round(((totals[currency] ?? 0) + c.amount) * 100) / 100
  }
  return totals
}

/** Review & Submit Agent, final step: the employee's one-click submission
 * (the brief: "Employee reviews prefilled data; one-click submission").
 * Bundles every claim they've reviewed but not yet submitted into one
 * expense report and marks them submitted, which locks them; the admin then
 * approves or rejects each. A claim can be in only one report (enforced in
 * the same transaction that writes it). */
export async function submitReport(employeeId: string): Promise<SubmitReportResult> {
  const who = employeeId.trim().toUpperCase()
  if (!who) return { success: false, reason: 'No employee given.' }

  const claims = readyForReport(await repo.listClaims(), who)
  if (claims.length === 0) {
    return { success: false, reason: `${who} has no claims waiting to be submitted.` }
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
