import * as repo from '../../modules/storage/repository'
import { saveReceiptFile, hashFile } from '../../modules/storage/opfs'
import { detectFileKind } from '../../modules/validation/fileSignature'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { generateId } from '../../utils/id'
import type { ReceiptRecord } from '../../types/records'

export const MAX_RECEIPT_SIZE_BYTES = 15 * 1024 * 1024 // 15MB cap, per plan decision #6

export type IngestResult =
  | { success: true; receipt: ReceiptRecord }
  | { success: false; reason: string }

/** Document Ingestion Agent — validates a receipt file and, only if it
 * passes, registers it (OPFS + a Dexie record). Nothing is written to
 * storage for a rejected file. */
export async function ingestReceipt(file: File, employeeId?: string): Promise<IngestResult> {
  if (file.size === 0) {
    return { success: false, reason: 'File is empty.' }
  }
  if (file.size > MAX_RECEIPT_SIZE_BYTES) {
    return {
      success: false,
      reason: `File is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the 15MB limit.`,
    }
  }

  const kind = await detectFileKind(file)
  if (!kind) {
    return {
      success: false,
      reason: "File content doesn't match a supported PDF, JPEG, or PNG signature.",
    }
  }

  const receiptId = generateId('rec')
  const opfsPath = await saveReceiptFile(receiptId, file)
  const fileHash = await hashFile(file)

  const receipt: ReceiptRecord = {
    receiptId,
    fileName: file.name,
    fileType: kind,
    fileSize: file.size,
    opfsPath,
    fileHash,
    status: 'registered',
    uploadedAt: new Date().toISOString(),
    ...(employeeId?.trim() ? { employeeId: employeeId.trim().toUpperCase() } : {}),
  }
  await repo.addReceipt(receipt)
  await appendAuditEntry(receiptId, 'RECEIPT_INGESTED', `${file.name} (${kind}, ${fileHash.slice(0, 12)}…)`)

  return { success: true, receipt }
}
