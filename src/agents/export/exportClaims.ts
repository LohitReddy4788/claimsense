import * as XLSX from 'xlsx'
import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import type { ClaimRecord } from '../../types/records'

/** Which claims a download contains. Approved claims are the ones that
 * passed the human gate; "not approved" (draft or flagged for review) is
 * for a manager working through what's still open. */
export type ExportScope = 'approved' | 'pending' | 'all'

const SCOPE = {
  approved: { sheet: 'Approved Claims', file: 'approved', words: 'approved', match: (c: ClaimRecord) => c.status === 'approved' },
  pending: { sheet: 'Not Approved Claims', file: 'not-approved', words: 'not approved', match: (c: ClaimRecord) => c.status !== 'approved' },
  all: { sheet: 'All Claims', file: 'all', words: '', match: () => true },
} as const

export type ExportResult =
  | { success: true; claimCount: number; fileName: string }
  | { success: false; reason: string }

export type WorkbookBuildResult =
  | { success: true; workbook: XLSX.WorkBook; claimCount: number }
  | { success: false; reason: string }

function claimToRow(claim: ClaimRecord, receiptFileName: string) {
  return {
    'Claim ID': claim.claimId,
    Status: claim.status,
    Employee: claim.employeeId ?? '',
    Receipt: receiptFileName,
    Vendor: claim.vendor ?? '',
    Amount: claim.amount ?? '',
    Currency: claim.currency ?? '',
    Date: claim.date ?? '',
    Category: claim.category,
    'Travel Request': claim.travelRequestId ?? '',
    'Travel Match': claim.travelMatch ?? '',
    'Policy Result': claim.policyResult ?? '',
    'Policy Reason': claim.policyReasonCode ?? '',
    'Duplicate Of': claim.duplicateOfClaimId ?? '',
    'Consistency Check': claim.lineItemReviewReason ?? '',
    'Approved At': claim.approvedAt ?? '',
    'Report ID': claim.reportId ?? '',
  }
}

/** Sheet Export module — builds an XLSX workbook from claims, entirely
 * client-side (SheetJS's write path never touches the network). Only
 * 'approved' claims are included, per the plan's own wording ("export
 * only after review") — a draft or still-flagged claim hasn't been
 * through the human gate yet and has no business leaving the app in an
 * exportable file. Logs the export itself to the audit trail (gap not
 * originally in the plan's wording, but "who exported what, when" is
 * exactly the kind of workflow action Phase 12's chain exists to record —
 * an export is a real action with consequences, same as an approval). */
/** Builds the workbook without writing a file — split out from
 * exportApprovedClaims() so the actual row-mapping logic can be tested
 * directly (parse the workbook back and check its rows) without also
 * needing to intercept a real browser file-save dialog. */
export function buildApprovedClaimsWorkbook(): Promise<WorkbookBuildResult> {
  return buildClaimsWorkbook('approved')
}

export async function buildClaimsWorkbook(scope: ExportScope): Promise<WorkbookBuildResult> {
  const [allClaims, allReceipts] = await Promise.all([repo.listClaims(), repo.listReceipts()])
  const receiptsById = Object.fromEntries(allReceipts.map((r) => [r.receiptId, r]))
  const { sheet, match } = SCOPE[scope]

  const approved = allClaims.filter(match)
  if (approved.length === 0) {
    return {
      success: false,
      reason:
        scope === 'approved'
          ? 'No approved claims to export yet — approve at least one claim first.'
          : scope === 'pending'
            ? 'Every claim is approved; there are no unapproved claims to export.'
            : 'There are no claims to export yet.',
    }
  }

  const rows = approved.map((c) => claimToRow(c, receiptsById[c.receiptId]?.fileName ?? c.receiptId))
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheet)

  // One row per line item with its own category, so a hotel bill's
  // restaurant charge is visible as Meals rather than hidden in Lodging.
  const lineRows = approved.flatMap((c) =>
    c.lineItems.map((item) => ({
      'Claim ID': c.claimId,
      Description: item.description,
      Amount: item.amount ?? '',
      Category: item.category,
      'Category Source': item.inherited ? 'receipt' : 'line text',
    })),
  )
  if (lineRows.length > 0) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(lineRows), 'Line Items')
  }

  // The submitted expense claims themselves, one row per report (only
  // approved claims can be in a report).
  const reports = scope === 'pending' ? [] : await repo.listReports()
  if (reports.length > 0) {
    const reportRows = reports.map((r) => ({
      'Report ID': r.reportId,
      Employee: r.employeeId,
      Claims: r.claimCount,
      Totals: Object.entries(r.totals)
        .map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`)
        .join(' + '),
      'Submitted At': r.submittedAt,
    }))
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(reportRows), 'Reports')
  }

  return { success: true, workbook, claimCount: approved.length }
}

export function exportApprovedClaims(): Promise<ExportResult> {
  return exportClaims('approved')
}

export async function exportClaims(scope: ExportScope): Promise<ExportResult> {
  const built = await buildClaimsWorkbook(scope)
  if (!built.success) {
    return built
  }

  const fileName = `claimsense-${SCOPE[scope].file}-claims-${new Date().toISOString().slice(0, 10)}.xlsx`
  XLSX.writeFile(built.workbook, fileName)

  const words = SCOPE[scope].words
  await appendAuditEntry(
    'export',
    'CLAIMS_EXPORTED',
    `${built.claimCount} ${words ? `${words} ` : ''}claim(s) exported to ${fileName}`,
  )

  return { success: true, claimCount: built.claimCount, fileName }
}
