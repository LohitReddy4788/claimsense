export type PolicyCheckStatus = 'PASS' | 'VIOLATION' | 'REVIEW'

export interface PolicyCheckResult {
  status: PolicyCheckStatus
  /** Machine-readable code like HOTEL_LIMIT_EXCEEDED or CURRENCY_UNSUPPORTED
   * — null only for a clean PASS. */
  reasonCode: string | null
  message: string
  /** Amount converted to the base currency, when conversion was possible. */
  convertedAmount: number | null
  baseCurrency: string | null
}
