import * as repo from '../../modules/storage/repository'
import { deleteAllReceiptFiles } from '../../modules/storage/opfs'
import { appendAuditEntry } from '../../modules/audit/auditLog'

/** The admin's "start over": removes all data from this device — the
 * database records and the receipt files — and starts a new audit log
 * whose first entry records the reset. */
export async function resetAllData(): Promise<void> {
  await repo.resetAllData()
  await deleteAllReceiptFiles()
  await appendAuditEntry('admin', 'DATA_RESET', 'all data on this device removed by the admin')
}
