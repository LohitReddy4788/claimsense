export type ReconciliationStatus = 'MATCHED' | 'REVIEW' | 'UNMATCHED'

export interface ReconciliationResult {
  status: ReconciliationStatus
  travelRequestId: string | null
  score: number
  reason: string
}
