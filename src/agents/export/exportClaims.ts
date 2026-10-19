import * as XLSX from 'xlsx'
import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import type { ClaimRecord } from '../../types/records'

export type ExportResult =
  | { success: true; claimCount: number; fileName: string }
  | { success: false; reason: string }

export type WorkbookBuildResult =
  | { success: true; workbook: XLSX.WorkBook; claimCount: number }
  | { success: false; reason: string }

function claimToRow(claim: ClaimRecord, receiptFileName: string) {
  return {
    'Claim ID': claim.claimId,
    Receipt: receiptFileName,
    Vendor: claim.vendor ?? '',
    Amount: claim.amount ?? '',
    Currency: claim.currency ?? '',
    Date: claim.date ?? '',
    Category: claim.category,
    'Travel Request': claim.travelRequestId ?? '',
    'Policy Result': claim.policyResult ?? '',
    'Policy Reason': claim.policyReasonCode ?? '',
    'Duplicate Of': claim.duplicateOfClaimId ?? '',
    'Consistency Check': claim.lineItemReviewReason ?? '',
    'Approved At': claim.approvedAt ?? '',
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
export async function buildApprovedClaimsWorkbook(): Promise<WorkbookBuildResult> {
  const [allClaims, allReceipts] = await Promise.all([repo.listClaims(), repo.listReceipts()])
  const receiptsById = Object.fromEntries(allReceipts.map((r) => [r.receiptId, r]))

  const approved = allClaims.filter((c) => c.status === 'approved')
  if (approved.length === 0) {
    return { success: false, reason: 'No approved claims to export yet — approve at least one claim first.' }
  }

  const rows = approved.map((c) => claimToRow(c, receiptsById[c.receiptId]?.fileName ?? c.receiptId))
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Approved Claims')

  return { success: true, workbook, claimCount: approved.length }
}

export async function exportApprovedClaims(): Promise<ExportResult> {
  const built = await buildApprovedClaimsWorkbook()
  if (!built.success) {
    return built
  }

  const fileName = `claimsense-export-${new Date().toISOString().slice(0, 10)}.xlsx`
  XLSX.writeFile(built.workbook, fileName)

  await appendAuditEntry(
    'export',
    'CLAIMS_EXPORTED',
    `${built.claimCount} approved claim(s) exported to ${fileName}`,
  )

  return { success: true, claimCount: built.claimCount, fileName }
}
