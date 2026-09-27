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
  notes?: string
}

/** Singleton row (id always "default"). Holds the base currency and the
 * static local conversion table decided in the gap audit — no live FX API,
 * a currency missing from `rates` must be treated as unsupported, not guessed. */
export interface PolicySettingsRecord {
  id: 'default'
  baseCurrency: string
  rates: Record<string, number>
}

export interface ClaimRecord {
  claimId: string
  receiptId: string
  /** Reused for exact-file duplicate detection (gap-fix #1) without a join
   * back to the receipts table. */
  fileHash: string
  // Nullable, not forced-placeholder strings — extraction can genuinely
  // fail to produce these (proven in Phase 5/6 testing), and inventing a
  // value here would violate the same never-guess principle the Policy
  // Engine and Reconciler already follow.
  vendor: string | null
  amount: number | null
  currency: string | null
  date: string | null
  category: string
  travelRequestId: string | null
  policyResult: 'PASS' | 'VIOLATION' | 'REVIEW' | null
  policyReasonCode: string | null
  /** claimId of the existing claim this one appears to duplicate, if any
   * (gap-fix #1: exact file hash OR normalized vendor+date+amount+currency). */
  duplicateOfClaimId: string | null
  /** Non-null when the extracted line items sum to more than the claimed
   * total — a receipt's line items can legitimately sum to LESS than the
   * total (tax/tip often aren't itemized), but never legitimately more.
   * One deterministic, honest signal toward a doctored or misread total;
   * not a fraud verdict, just a reason to route to human review. */
  lineItemReviewReason: string | null
  status: 'draft' | 'review' | 'approved'
  createdAt: string
  /** Set only when a human explicitly approves via the Review & Submit
   * step (Phase 11) — null means still draft/review, never approved. */
  approvedAt: string | null
}

export interface AuditLogRecord {
  id?: number
  entityId: string
  action: string
  /** Human-readable summary of what happened (e.g. "vendor: X -> Y"). Part
   * of the hash input, not just display text — changing this after the
   * fact without recomputing the hash is exactly the tampering the chain
   * is built to catch. */
  detail: string
  currentHash: string
  previousHash: string
  timestamp: string
}
