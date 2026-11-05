import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'

vi.mock('../../src/modules/storage/pg', async (orig) => ({
  ...(await orig<object>()),
  getPg: async () => (await import('../helpers/testDb')).currentDb(),
}))
// OPFS is browser-only; everything else in ingestion runs for real.
vi.mock('../../src/modules/storage/opfs', async (orig) => ({
  ...(await orig<object>()),
  saveReceiptFile: async (id: string) => `receipts/${id}`,
}))

const { resetDb } = await import('../helpers/testDb')
const repo = await import('../../src/modules/storage/repository')
const { ingestReceipt } = await import('../../src/agents/ingestion/ingestReceipt')
const { populateClaim } = await import('../../src/agents/sheet/populateClaim')
const { editClaim, approveClaim } = await import('../../src/agents/review/reviewClaim')
const { buildApprovedClaimsWorkbook } = await import('../../src/agents/export/exportClaims')
const { verifyAuditChain } = await import('../../src/modules/audit/auditLog')
const { evaluatePolicy } = await import('../../src/modules/policy/policyEngine')
import type { ExtractedReceiptData } from '../../src/types/extraction'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (name: string, extra = 'a') => new File([new Uint8Array(PNG), extra], name, { type: 'image/png' })

const SETTINGS = { id: 'default' as const, baseCurrency: 'USD', rates: { EUR: 1.1 } }
const meal: ExtractedReceiptData = { vendor: 'Blue Bottle Coffee', amount: 40, currency: 'USD', date: '2026-03-12', lineItems: [] }
const unmatched = { status: 'UNMATCHED' as const, travelRequestId: null, score: 0, reason: '' }

beforeEach(async () => {
  await resetDb()
  await repo.addPolicy({ policyId: 'p1', category: 'Meals', limitAmount: 75 })
  await repo.putPolicySettings(SETTINGS)
})

async function ingestAndBuild(file: File, data: ExtractedReceiptData = meal) {
  const ingested = await ingestReceipt(file)
  if (!ingested.success) throw new Error(ingested.reason)
  const policy = evaluatePolicy(data, 'Meals', await repo.listPolicies(), SETTINGS)
  return populateClaim({
    receiptId: ingested.receipt.receiptId,
    employeeId: 'EMP001',
    fileHash: ingested.receipt.fileHash,
    data,
    extractionStatus: 'valid',
    category: 'Meals',
    reconciliation: unmatched,
    policy,
  })
}

describe('Document Ingestion Agent', () => {
  it('registers a valid receipt with its SHA-256 hash and an audit entry', async () => {
    const r = await ingestReceipt(png('lunch.png'))
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.receipt.fileHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.receipt.fileType).toBe('png')
    expect(await repo.listReceipts()).toHaveLength(1)
    expect((await repo.listAuditLogs())[0].action).toBe('RECEIPT_INGESTED')
  })

  it('rejects empty, oversize and disguised files without storing anything', async () => {
    const empty = new File([], 'empty.png')
    const huge = new File([new Uint8Array(PNG), new Uint8Array(16 * 1024 * 1024)], 'huge.png')
    const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0])], 'invoice.pdf')
    for (const [file, reason] of [[empty, /empty/], [huge, /15MB/], [exe, /signature/]] as const) {
      const r = await ingestReceipt(file)
      expect(r.success).toBe(false)
      if (!r.success) expect(r.reason).toMatch(reason)
    }
    expect(await repo.listReceipts()).toHaveLength(0)
  })
})

describe('Sheet Populator Agent', () => {
  it('builds a clean draft when every check passes', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    expect(claim).toMatchObject({ status: 'draft', policyResult: 'PASS', duplicateOfClaimId: null })
  })

  it('stores who the claim is for, the trip-match status and categorised line items (audit fix)', async () => {
    const claim = await ingestAndBuild(png('a.png'), {
      ...meal,
      lineItems: [
        { description: 'Croissant', amount: 5.5 },
        { description: 'Parking', amount: 4 },
      ],
    })
    const stored = await repo.getClaim(claim.claimId)
    expect(stored).toMatchObject({
      employeeId: 'EMP001',
      travelMatch: 'UNMATCHED',
      lineItems: [
        { description: 'Croissant', amount: 5.5, category: 'Meals', inherited: true },
        { description: 'Parking', amount: 4, category: 'Travel', inherited: false },
      ],
    })
  })

  it('marks the receipt processed once its claim exists (audit fix)', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    const receipt = (await repo.listReceipts()).find((r) => r.receiptId === claim.receiptId)
    expect(receipt?.status).toBe('processed')
  })

  it('routes a policy violation to review with its reason code', async () => {
    const claim = await ingestAndBuild(png('a.png'), { ...meal, amount: 120 })
    expect(claim).toMatchObject({ status: 'review', policyResult: 'VIOLATION', policyReasonCode: 'MEALS_LIMIT_EXCEEDED' })
  })

  it('flags a re-upload of the same file as a duplicate', async () => {
    const first = await ingestAndBuild(png('a.png', 'same'))
    const second = await ingestAndBuild(png('a-copy.png', 'same'))
    expect(second).toMatchObject({ status: 'review', duplicateOfClaimId: first.claimId })
  })

  it('flags the same receipt photographed twice (fuzzy vendor/date/amount match)', async () => {
    const first = await ingestAndBuild(png('a.png', 'photo1'))
    const second = await ingestAndBuild(png('b.png', 'photo2'), { ...meal, vendor: 'BLUE  BOTTLE COFFEE!!' })
    expect(second.duplicateOfClaimId).toBe(first.claimId)
  })

  it('routes inconsistent line items to review', async () => {
    const claim = await ingestAndBuild(png('a.png'), { ...meal, lineItems: [{ description: 'x', amount: 90 }] })
    expect(claim.status).toBe('review')
    expect(claim.lineItemReviewReason).toMatch(/Line items sum/)
  })
})

describe('Review & Submit Agent', () => {
  it('approves a claim once and refuses a second approval', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    const first = await approveClaim(claim.claimId)
    expect(first.success).toBe(true)
    if (first.success) expect(first.claim.approvedAt).not.toBeNull()
    expect(await approveClaim(claim.claimId)).toMatchObject({ success: false })
    expect(await approveClaim('claim_missing')).toMatchObject({ success: false })
  })

  it('re-checks the policy when a reviewer corrects the amount (audit fix)', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    expect(claim.policyResult).toBe('PASS')

    await editClaim(claim.claimId, { amount: 500 })
    const edited = await repo.getClaim(claim.claimId)
    expect(edited).toMatchObject({ amount: 500, policyResult: 'VIOLATION', policyReasonCode: 'MEALS_LIMIT_EXCEEDED', status: 'review' })

    const actions = (await repo.listAuditLogs()).map((e) => e.action)
    expect(actions.slice(-2)).toEqual(['CLAIM_EDITED', 'POLICY_REEVALUATED'])
  })

  it('re-checks the policy when the category or currency changes', async () => {
    const claim = await ingestAndBuild(png('a.png'), { ...meal, amount: 70 })
    await editClaim(claim.claimId, { currency: 'EUR' }) // 70 EUR = 77 USD > 75
    expect((await repo.getClaim(claim.claimId))?.policyResult).toBe('VIOLATION')
    await editClaim(claim.claimId, { category: 'Communication' })
    expect((await repo.getClaim(claim.claimId))?.policyReasonCode).toBe('NO_POLICY_DEFINED')
  })

  it('lets a reviewer fill in a date OCR could not read', async () => {
    const claim = await ingestAndBuild(png('a.png'), { ...meal, date: null })
    await editClaim(claim.claimId, { date: '2026-03-12' })
    expect((await repo.getClaim(claim.claimId))?.date).toBe('2026-03-12')
  })

  it('refuses to edit an approved claim', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    await approveClaim(claim.claimId)
    await expect(editClaim(claim.claimId, { amount: 1 })).rejects.toThrow(/already approved/)
    expect((await repo.getClaim(claim.claimId))?.amount).toBe(40)
  })
})

describe('Claims spreadsheet export', () => {
  it('refuses to export before anything is approved', async () => {
    await ingestAndBuild(png('a.png'))
    expect(await buildApprovedClaimsWorkbook()).toMatchObject({ success: false })
  })

  it('exports only approved claims, with policy and audit columns', async () => {
    const approved = await ingestAndBuild(png('lunch.png', '1'), {
      ...meal,
      lineItems: [{ description: 'Sandwich', amount: 12 }],
    })
    await ingestAndBuild(png('other.png', '2'), { ...meal, vendor: 'Other Cafe', amount: 120 })
    await approveClaim(approved.claimId)

    const built = await buildApprovedClaimsWorkbook()
    expect(built.success).toBe(true)
    if (!built.success) return
    // Write to real .xlsx bytes and read back, as Excel would.
    const bytes = XLSX.write(built.workbook, { type: 'array', bookType: 'xlsx' })
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.read(bytes).Sheets['Approved Claims'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      'Claim ID': approved.claimId,
      Receipt: 'lunch.png',
      Vendor: 'Blue Bottle Coffee',
      Amount: 40,
      Currency: 'USD',
      Category: 'Meals',
      'Policy Result': 'PASS',
      Employee: 'EMP001',
      'Travel Match': 'UNMATCHED',
    })
    expect(rows[0]['Approved At']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const items = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.read(bytes).Sheets['Line Items'])
    expect(items).toEqual([
      { 'Claim ID': approved.claimId, Description: 'Sandwich', Amount: 12, Category: 'Meals', 'Category Source': 'line text' },
    ])
  })

  it('leaves an intact audit chain after the whole lifecycle', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    await editClaim(claim.claimId, { amount: 500 })
    await approveClaim(claim.claimId)
    const v = await verifyAuditChain()
    expect(v.valid).toBe(true)
    expect(v.totalEntries).toBe(5) // ingested, created, edited, re-evaluated, approved
  })
})
