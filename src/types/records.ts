export interface ReceiptRecord {
  receiptId: string
  fileName: string
  fileType: string
  fileSize: number
  opfsPath: string
  fileHash: string
  status: 'registered' | 'processed' | 'rejected'
  uploadedAt: string
}

export interface TravelRequestRecord {
  requestId: string
  employeeId: string
  destination: string
  startDate: string
  endDate: string
  approvalStatus: 'approved' | 'pending' | 'rejected'
}

export interface PolicyRecord {
  policyId: string
  category: string
  limitAmount: number
  baseCurrency: string
  notes?: string
}

export interface ClaimRecord {
  claimId: string
  receiptId: string
  vendor: string
  amount: number
  currency: string
  category: string
  travelRequestId: string | null
  policyResult: 'PASS' | 'VIOLATION' | 'REVIEW' | null
  status: 'draft' | 'review' | 'approved'
  createdAt: string
}

export interface AuditLogRecord {
  id?: number
  entityId: string
  action: string
  currentHash: string
  previousHash: string
  timestamp: string
}
