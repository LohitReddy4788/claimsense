import Dexie, { type EntityTable } from 'dexie'
import type {
  ReceiptRecord,
  TravelRequestRecord,
  PolicyRecord,
  PolicySettingsRecord,
  ClaimRecord,
  AuditLogRecord,
} from '../../types/records'

export const db = new Dexie('claimsense') as Dexie & {
  receipts: EntityTable<ReceiptRecord, 'receiptId'>
  travelRequests: EntityTable<TravelRequestRecord, 'requestId'>
  policies: EntityTable<PolicyRecord, 'policyId'>
  policySettings: EntityTable<PolicySettingsRecord, 'id'>
  claims: EntityTable<ClaimRecord, 'claimId'>
  auditLogs: EntityTable<AuditLogRecord, 'id'>
}

db.version(1).stores({
  receipts: 'receiptId, status, uploadedAt',
  travelRequests: 'requestId, employeeId, approvalStatus',
  policies: 'policyId, category',
  claims: 'claimId, receiptId, status',
  auditLogs: '++id, entityId, timestamp',
})

db.version(2).stores({
  policySettings: 'id',
})

// v3: claims.createdAt needed to be indexed for ClaimsPanel's
// orderBy('createdAt') — without it Dexie throws a SchemaError on every
// refresh(), which was being silently swallowed and made the Claims tab
// look permanently stuck at 0 even though the underlying data was fine.
db.version(3).stores({
  claims: 'claimId, receiptId, status, createdAt',
})
