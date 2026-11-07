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
const { editClaim, approveClaim, rejectClaim, reopenClaim } = await import('../../src/agents/review/reviewClaim')
const { buildApprovedClaimsWorkbook, buildClaimsWorkbook } = await import('../../src/agents/export/exportClaims')
const { submitReport } = await import('../../src/agents/review/submitReport')
const { requestTravel, decideTravelRequest } = await import('../../src/agents/travel/decideTravelRequest')
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

async function ingestAndBuild(file: File, data: ExtractedReceiptData = meal, employeeId = 'EMP001') {
  const ingested = await ingestReceipt(file)
  if (!ingested.success) throw new Error(ingested.reason)
  const policy = evaluatePolicy(data, 'Meals', await repo.listPolicies(), SETTINGS)
  return populateClaim({
    receiptId: ingested.receipt.receiptId,
    employeeId,
    fileHash: ingested.receipt.fileHash,
    data,
    extractionStatus: 'valid',
    category: 'Meals',
    reconciliation: unmatched,
    policy,
  })
}

// What the employee's one-click submission does to a single claim, for
// tests about the admin's decision on it (submission itself is tested with
// the real submitReport below).
const submit = (claimId: string) => repo.updateClaim(claimId, { status: 'submitted' })

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
  it('approves a submitted claim once and refuses a second approval', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    expect(await approveClaim(claim.claimId)).toMatchObject({ success: false, reason: expect.stringMatching(/not submitted/) })
    await submit(claim.claimId)
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

  it('refuses to edit a submitted or approved claim', async () => {
    const claim = await ingestAndBuild(png('a.png'))
    await submit(claim.claimId)
    await expect(editClaim(claim.claimId, { amount: 1 })).rejects.toThrow(/submitted/)
    await approveClaim(claim.claimId)
    await expect(editClaim(claim.claimId, { amount: 1 })).rejects.toThrow(/already approved/)
    expect((await repo.getClaim(claim.claimId))?.amount).toBe(40)
  })
})

describe('Rejecting a claim', () => {
  it('records the reason, locks the claim, and logs it', async () => {
    const c = await ingestAndBuild(png('lunch.png'))
    expect(await rejectClaim(c.claimId, 'x')).toMatchObject({ success: false })
    await submit(c.claimId)
    const r = await rejectClaim(c.claimId, '  personal expense ')
    expect(r).toMatchObject({ success: true, claim: { status: 'rejected', rejectionReason: 'personal expense' } })
    expect((await repo.getClaim(c.claimId))?.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await approveClaim(c.claimId)).toMatchObject({ success: false })
    await expect(editClaim(c.claimId, { amount: 1 })).rejects.toThrow(/rejected/)
    expect(await rejectClaim(c.claimId, '')).toMatchObject({ success: false })
    const log = await repo.listAuditLogs()
    expect(log.at(-1)).toMatchObject({ action: 'CLAIM_REJECTED' })
    expect(log.at(-1)?.detail).toContain('personal expense')
    expect(await verifyAuditChain()).toMatchObject({ valid: true })
  })

  it('cannot reject an approved claim', async () => {
    const c = await ingestAndBuild(png('lunch.png'))
    await submit(c.claimId)
    await approveClaim(c.claimId)
    expect(await rejectClaim(c.claimId, 'no')).toMatchObject({ success: false })
  })

  it('reopens a rejected claim to the employee, who can correct and resubmit it', async () => {
    const c = await ingestAndBuild(png('lunch.png'))
    const first = await submitReport('EMP001')
    if (!first.success) throw new Error(first.reason)
    await rejectClaim(c.claimId, 'wrong trip')
    expect(await reopenClaim(c.claimId)).toMatchObject({ success: true, claim: { status: 'review' } })
    const after = await repo.getClaim(c.claimId)
    expect(after?.rejectionReason ?? null).toBeNull()
    expect(after?.rejectedAt ?? null).toBeNull()
    expect(after?.reportId ?? null).toBeNull()
    await editClaim(c.claimId, { amount: 35 })
    const second = await submitReport('EMP001')
    expect(second).toMatchObject({ success: true, report: { claimCount: 1, totals: { USD: 35 } } })
    expect(await approveClaim(c.claimId)).toMatchObject({ success: true })
    expect(await reopenClaim(c.claimId)).toMatchObject({ success: false })
  })

  it('lists a rejected claim, with its reason, in the not-approved download', async () => {
    const c = await ingestAndBuild(png('lunch.png'))
    await submit(c.claimId)
    await rejectClaim(c.claimId, 'duplicate of paper receipt')
    const built = await buildClaimsWorkbook('pending')
    if (!built.success) throw new Error(built.reason)
    const wb = XLSX.read(XLSX.write(built.workbook, { type: 'array', bookType: 'xlsx' }))
    expect(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Not Approved Claims'])[0]).toMatchObject({
      Status: 'rejected',
      'Rejection Reason': 'duplicate of paper receipt',
    })
  })
})

describe('Claims spreadsheet export', () => {
  it('downloads approved, not approved, or all claims, each with its status', async () => {
    const a = await ingestAndBuild(png('lunch.png', '1'))
    const b = await ingestAndBuild(png('other.png', '2'), { ...meal, vendor: 'Other Cafe', amount: 120 })
    await submit(a.claimId)
    await approveClaim(a.claimId)
    const sheetRows = async (scope: 'approved' | 'pending' | 'all', sheet: string) => {
      const built = await buildClaimsWorkbook(scope)
      if (!built.success) throw new Error(built.reason)
      const wb = XLSX.read(XLSX.write(built.workbook, { type: 'array', bookType: 'xlsx' }))
      return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet]).map((r) => [r['Claim ID'], r.Status])
    }
    expect(await sheetRows('approved', 'Approved Claims')).toEqual([[a.claimId, 'approved']])
    expect(await sheetRows('pending', 'Not Approved Claims')).toEqual([[b.claimId, b.status]])
    expect((await sheetRows('all', 'All Claims')).map(([id]) => id).sort()).toEqual([a.claimId, b.claimId].sort())
  })

  it('says so when there is nothing unapproved to download', async () => {
    const a = await ingestAndBuild(png('lunch.png', '1'))
    await submit(a.claimId)
    await approveClaim(a.claimId)
    expect(await buildClaimsWorkbook('pending')).toMatchObject({ success: false })
  })

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
    await submit(approved.claimId)
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
    await submitReport('EMP001')
    await approveClaim(claim.claimId)
    const v = await verifyAuditChain()
    expect(v.valid).toBe(true)
    expect(v.totalEntries).toBe(6) // ingested, created, edited, re-evaluated, report submitted, approved
  })
})

describe('Re-checks after a correction (audit fix)', () => {
  beforeEach(async () => {
    await repo.addTravelRequest({
      requestId: 'TR-BOS', employeeId: 'EMP001', destination: 'Boston',
      startDate: '2026-03-10', endDate: '2026-03-14', approvalStatus: 'approved',
    })
  })

  it('re-runs the trip match when the date is corrected', async () => {
    const claim = await ingestAndBuild(png('a.png'), { ...meal, vendor: 'Boston Bagel Cafe', date: '2026-06-01' })
    expect(claim.travelMatch).toBe('UNMATCHED')
    await editClaim(claim.claimId, { date: '2026-03-12' })
    expect(await repo.getClaim(claim.claimId)).toMatchObject({ travelMatch: 'MATCHED', travelRequestId: 'TR-BOS' })
    expect((await repo.listAuditLogs()).at(-1)?.action).toBe('TRAVEL_REMATCHED')
  })

  it('moves inherited line items with a category change, and checks them against their limit', async () => {
    await repo.addPolicy({ policyId: 'p2', category: 'Lodging', limitAmount: 500 })
    const claim = await ingestAndBuild(png('a.png'), {
      ...meal,
      amount: 300,
      lineItems: [{ description: 'Suite upgrade', amount: 210 }, { description: 'Restaurant', amount: 90 }],
    })
    // Read as Meals: 300 > 75. The reviewer corrects it to Lodging.
    await editClaim(claim.claimId, { category: 'Lodging' })
    const edited = await repo.getClaim(claim.claimId)
    expect(edited?.lineItems.map((i) => i.category)).toEqual(['Lodging', 'Meals'])
    // 300 is within Lodging's 500, but the 90 restaurant line is over Meals' 75.
    expect(edited).toMatchObject({ policyResult: 'VIOLATION', policyReasonCode: 'MEALS_LIMIT_EXCEEDED' })
  })
})

describe('Expense reports: the employee’s one-click submission', () => {
  const build = (name: string, data: ExtractedReceiptData = meal, employeeId = 'EMP001') =>
    ingestAndBuild(png(name, name), data, employeeId)

  it('submits all of an employee’s open claims as one report, with per-currency totals', async () => {
    const a = await build('a.png', { ...meal, vendor: 'A', amount: 40 })
    const b = await build('b.png', { ...meal, vendor: 'B', amount: 12.5 })
    const c = await build('c.png', { ...meal, vendor: 'C', amount: 20, currency: 'EUR' })
    const other = await build('other.png', { ...meal, vendor: 'E' }, 'EMP002') // someone else: left out

    const r = await submitReport('emp001')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.report).toMatchObject({ employeeId: 'EMP001', claimCount: 3, totals: { USD: 52.5, EUR: 20 } })
    for (const id of [a.claimId, b.claimId, c.claimId]) {
      expect(await repo.getClaim(id)).toMatchObject({ reportId: r.report.reportId, status: 'submitted' })
    }
    expect(await repo.getClaim(other.claimId)).toMatchObject({ status: other.status, reportId: null })
    expect(await repo.listReports()).toEqual([r.report])
    expect((await repo.listAuditLogs()).at(-1)).toMatchObject({ entityId: r.report.reportId, action: 'REPORT_SUBMITTED' })
    expect((await verifyAuditChain()).valid).toBe(true)
  })

  it('never puts a claim in two reports, even when submitted twice at once', async () => {
    await build('a.png')
    const results = await Promise.all([submitReport('EMP001'), submitReport('EMP001')])
    expect(results.filter((r) => r.success)).toHaveLength(1)
    expect(await repo.listReports()).toHaveLength(1)
    expect(await submitReport('EMP001')).toMatchObject({ success: false, reason: expect.stringMatching(/no claims waiting/) })
  })

  it('refuses when there is nothing to submit', async () => {
    expect(await submitReport('EMP001')).toMatchObject({ success: false })
    expect(await submitReport('  ')).toMatchObject({ success: false })
  })

  it('exports the report and each approved claim’s report ID', async () => {
    const claim = await build('a.png')
    const r = await submitReport('EMP001')
    if (!r.success) throw new Error(r.reason)
    await approveClaim(claim.claimId)
    const built = await buildApprovedClaimsWorkbook()
    if (!built.success) throw new Error(built.reason)
    const wb = XLSX.read(XLSX.write(built.workbook, { type: 'array', bookType: 'xlsx' }))
    expect(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Approved Claims'])[0]).toMatchObject({
      'Claim ID': claim.claimId,
      'Report ID': r.report.reportId,
    })
    expect(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Reports'])).toEqual([
      { 'Report ID': r.report.reportId, Employee: 'EMP001', Claims: 1, Totals: '40.00 USD', 'Submitted At': r.report.submittedAt },
    ])
  })
})

describe('Travel requests: employee asks, admin decides', () => {
  it('records a request as pending and logs it', async () => {
    const r = await requestTravel({ employeeId: 'emp001', destination: 'Boston', startDate: '2026-03-10', endDate: '2026-03-14' })
    expect(r).toMatchObject({ success: true, request: { employeeId: 'EMP001', approvalStatus: 'pending' } })
    expect((await repo.listAuditLogs()).at(-1)).toMatchObject({ action: 'TRAVEL_REQUESTED' })
    expect(await requestTravel({ employeeId: 'EMP001', destination: 'X', startDate: '2026-03-14', endDate: '2026-03-10' })).toMatchObject({ success: false })
  })

  it('links receipts extracted before the trip was approved, once it is', async () => {
    const r = await requestTravel({ employeeId: 'EMP001', destination: 'Boston', startDate: '2026-03-10', endDate: '2026-03-14' })
    if (!r.success) throw new Error(r.reason)
    // Extracted while the trip was still pending: nothing to match yet.
    const claim = await ingestAndBuild(png('a.png'), { ...meal, vendor: 'Boston Bagel Cafe' })
    expect(claim.travelRequestId).toBeNull()

    const decided = await decideTravelRequest(r.request.requestId, 'approved')
    expect(decided).toMatchObject({ success: true, rematched: 1 })
    expect(await repo.getClaim(claim.claimId)).toMatchObject({ travelMatch: 'MATCHED', travelRequestId: r.request.requestId })
    const actions = (await repo.listAuditLogs()).map((e) => e.action)
    expect(actions.slice(-2)).toEqual(['TRAVEL_APPROVED', 'TRAVEL_REMATCHED'])
    expect(await decideTravelRequest(r.request.requestId, 'approved')).toMatchObject({ success: false })
  })

  it('unlinks open receipts when an approved trip is rejected, but never touches submitted ones', async () => {
    const r = await requestTravel({ employeeId: 'EMP001', destination: 'Boston', startDate: '2026-03-10', endDate: '2026-03-14' })
    if (!r.success) throw new Error(r.reason)
    const open = await ingestAndBuild(png('a.png', '1'), { ...meal, vendor: 'Boston Bagel Cafe' })
    const sent = await ingestAndBuild(png('b.png', '2'), { ...meal, vendor: 'Boston Taxi', amount: 30 })
    expect(await decideTravelRequest(r.request.requestId, 'approved')).toMatchObject({ rematched: 2 })
    await submit(sent.claimId)
    await decideTravelRequest(r.request.requestId, 'rejected')
    expect((await repo.getClaim(open.claimId))?.travelRequestId).toBeNull()
    expect((await repo.getClaim(sent.claimId))?.travelRequestId).toBe(r.request.requestId)
  })
})
