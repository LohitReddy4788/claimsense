import * as repo from '../../modules/storage/repository'
import { appendAuditEntry } from '../../modules/audit/auditLog'
import { generateId } from '../../utils/id'
import { checkReceiptIntegrity } from '../../modules/validation/receiptIntegrity'
import type { ExtractedReceiptData } from '../../types/extraction'
import type { ExpenseCategory } from '../../types/category'
import { classifyLineItems } from '../category/classifyCategory'
import type { ReconciliationResult } from '../../types/reconciliation'
import type { PolicyCheckResult } from '../../types/policy'
import type { ClaimRecord } from '../../types/records'

export interface PopulateClaimInput {
  receiptId: string
  employeeId: string
  fileHash: string
  data: ExtractedReceiptData
  /** From ValidatedReceipt.status — 'needs_review' means Phase 6 couldn't
   * get a complete result from either the VLM or the OCR fallback. */
  extractionStatus: 'valid' | 'needs_review'
  category: ExpenseCategory
  reconciliation: ReconciliationResult
  policy: PolicyCheckResult
}

function normalizeForDedup(value: string | null): string {
  // Found by testing: "Coffee House" vs "COFFEE  HOUSE!!" (double space)
  // normalized to "coffee house" vs "coffee  house" — different strings,
  // so a real duplicate was missed purely over whitespace. Collapsing runs
  // of whitespace to one space (not just trimming the ends) closes that.
  return (value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
}

function fuzzyDedupKey(vendor: string | null, date: string | null, amount: number | null, currency: string | null): string {
  return [normalizeForDedup(vendor), normalizeForDedup(date), amount ?? '', normalizeForDedup(currency)].join('|')
}

interface DuplicateCheck {
  duplicateOfClaimId: string | null
}

/** Gap-fix #1: dedup on exact-file SHA-256 (a literal re-upload of the same
 * file) OR normalized vendor+date+amount+currency (the same receipt entered
 * twice, e.g. from two different photos of the same paper). Either hit
 * flags for review — never silently rejected, since a false positive here
 * would be worse than an occasional missed duplicate. */
async function checkDuplicate(input: PopulateClaimInput): Promise<DuplicateCheck> {
  const existingClaims = await repo.listClaims()

  const exactHashMatch = existingClaims.find((c) => c.fileHash === input.fileHash)
  if (exactHashMatch) return { duplicateOfClaimId: exactHashMatch.claimId }

  const targetKey = fuzzyDedupKey(input.data.vendor, input.data.date, input.data.amount, input.data.currency)
  // An all-empty key (every field null/blank) matching another all-empty
  // key isn't a meaningful duplicate signal — skip it, or every
  // needs-review claim with no extracted data would "duplicate" every
  // other one.
  const isEmptyKey = !input.data.vendor && !input.data.date && input.data.amount === null
  if (!isEmptyKey) {
    const fuzzyMatch = existingClaims.find(
      (c) => fuzzyDedupKey(c.vendor, c.date, c.amount, c.currency) === targetKey,
    )
    if (fuzzyMatch) return { duplicateOfClaimId: fuzzyMatch.claimId }
  }

  return { duplicateOfClaimId: null }
}

/** Sheet Populator Agent — combines Phases 5-9's outputs into one claim
 * row. Decides draft vs. review here, not later: anything the pipeline is
 * uncertain about (incomplete extraction, a policy violation or review
 * flag, an ambiguous travel match, or a suspected duplicate) routes to
 * review rather than silently becoming a clean draft. An unmatched travel
 * link is NOT treated as uncertain — most expenses aren't travel-related,
 * so UNMATCHED is an expected, ordinary outcome, not a red flag. */
export async function populateClaim(input: PopulateClaimInput): Promise<ClaimRecord> {
  const { duplicateOfClaimId } = await checkDuplicate(input)
  // Line items vs total, printed subtotal+tax+tip vs total, and a
  // future-dated receipt — any one routes to review with its reason.
  const integrityCheck = checkReceiptIntegrity(input.data)

  const needsReview =
    input.extractionStatus === 'needs_review' ||
    input.policy.status !== 'PASS' ||
    input.reconciliation.status === 'REVIEW' ||
    duplicateOfClaimId !== null ||
    !integrityCheck.consistent

  const claim: ClaimRecord = {
    claimId: generateId('claim'),
    receiptId: input.receiptId,
    employeeId: input.employeeId,
    fileHash: input.fileHash,
    vendor: input.data.vendor,
    amount: input.data.amount,
    currency: input.data.currency,
    date: input.data.date,
    category: input.category,
    travelRequestId: input.reconciliation.travelRequestId,
    travelMatch: input.reconciliation.status,
    lineItems: classifyLineItems(input.data, input.category),
    policyResult: input.policy.status,
    policyReasonCode: input.policy.reasonCode,
    duplicateOfClaimId,
    lineItemReviewReason: integrityCheck.reason,
    status: needsReview ? 'review' : 'draft',
    reportId: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  }

  await repo.addClaim(claim)
  await repo.updateReceiptStatus(input.receiptId, 'processed')
  await appendAuditEntry(
    claim.claimId,
    'CLAIM_CREATED',
    `employee: ${claim.employeeId}, vendor: ${claim.vendor ?? '—'}, amount: ${claim.amount ?? '—'} ${claim.currency ?? ''}, status: ${claim.status}` +
      (duplicateOfClaimId ? `, possible duplicate of ${duplicateOfClaimId}` : '') +
      (integrityCheck.reason ? `, ${integrityCheck.reason}` : ''),
  )
  return claim
}
