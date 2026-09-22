import Dexie, { type EntityTable } from 'dexie'
import type {
  ReceiptRecord,
  TravelRequestRecord,
  PolicyRecord,
  ClaimRecord,
  AuditLogRecord,
} from '../../types/records'

export const db = new Dexie('claimsense') as Dexie & {
  receipts: EntityTable<ReceiptRecord, 'receiptId'>
  travelRequests: EntityTable<TravelRequestRecord, 'requestId'>
  policies: EntityTable<PolicyRecord, 'policyId'>
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
