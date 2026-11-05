import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionResult } from '../../src/types/extraction'
import type { ProcessResult } from '../../src/modules/document-processing/processDocument'

vi.mock('../../src/modules/storage/pg', async (orig) => ({
  ...(await orig<object>()),
  getPg: async () => (await import('../helpers/testDb')).currentDb(),
}))
vi.mock('../../src/modules/storage/opfs', async (orig) => ({
  ...(await orig<object>()),
  saveReceiptFile: async (id: string) => `receipts/${id}`,
}))
// The three steps that need a real browser (canvas/pdf.js, Tesseract, the
// ONNX model in a Web Worker) are replaced by controllable fakes. Every
// other agent — classifier, reconciler, policy engine, sheet populator,
// storage, audit — runs for real.
const processDocument = vi.fn<() => Promise<ProcessResult>>()
const runOcrFallback = vi.fn<() => Promise<ExtractionResult>>()
const extractReceipt = vi.fn<() => Promise<ExtractionResult>>()
vi.mock('../../src/modules/document-processing/processDocument', () => ({ processDocument: () => processDocument() }))
vi.mock('../../src/modules/validation/ocrTextParser', () => ({ runOcrFallback: () => runOcrFallback() }))
vi.mock('../../src/agents/extraction/extractReceipt', () => ({ extractReceipt: () => extractReceipt() }))

const { resetDb } = await import('../helpers/testDb')
const repo = await import('../../src/modules/storage/repository')
const { ingestReceipt } = await import('../../src/agents/ingestion/ingestReceipt')
const { runOrchestrator } = await import('../../src/agents/orchestrator/runOrchestrator')
const { verifyAuditChain } = await import('../../src/modules/audit/auditLog')

const processed: ProcessResult = { success: true, blob: new Blob(['img']), width: 800, height: 1200, pageCount: 1 }
const hotel = { vendor: 'Boston Harbor Hotel', amount: 310, currency: 'USD', date: '2026-03-12', lineItems: [{ description: 'Room', amount: 280 }] }
const ok = (data: typeof hotel, confidence = 1): ExtractionResult => ({ success: true, data, confidence, rawModelOutput: '', latencyMs: 1 })

async function run(employeeId = 'EMP001') {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47]), crypto.randomUUID()], 'hotel.png')
  const ingested = await ingestReceipt(file)
  if (!ingested.success) throw new Error(ingested.reason)
  const phases: string[] = []
  const result = await runOrchestrator(
    { receiptId: ingested.receipt.receiptId, fileHash: ingested.receipt.fileHash, file, kind: 'png', employeeId },
    (p) => phases.push(p),
  )
  return { result, phases }
}

beforeEach(async () => {
  await resetDb()
  processDocument.mockReset().mockResolvedValue(processed)
  runOcrFallback.mockReset().mockResolvedValue(ok(hotel))
  extractReceipt.mockReset().mockResolvedValue(ok(hotel))
  await repo.addPolicy({ policyId: 'p1', category: 'Lodging', limitAmount: 250 })
  await repo.putPolicySettings({ id: 'default', baseCurrency: 'USD', rates: {} })
  await repo.addTravelRequest({
    requestId: 'TR-42', employeeId: 'EMP001', destination: 'Boston',
    startDate: '2026-03-10', endDate: '2026-03-14', approvalStatus: 'approved',
  })
})

describe('Orchestrator Agent — full pipeline', () => {
  it('runs every agent in order and produces a reconciled, policy-checked claim', async () => {
    const { result, phases } = await run()
    expect(phases).toEqual(['processing', 'ocr', 'building', 'done'])
    expect(result.success).toBe(true)
    if (!result.success) return
    const { category, reconciliation, policy, claim } = result.built
    expect(category?.category).toBe('Lodging')
    expect(reconciliation).toMatchObject({ status: 'MATCHED', travelRequestId: 'TR-42' })
    expect(policy).toMatchObject({ status: 'VIOLATION', reasonCode: 'LODGING_LIMIT_EXCEEDED' })
    expect(claim).toMatchObject({ status: 'review', travelRequestId: 'TR-42', category: 'Lodging' })
    expect(extractReceipt).not.toHaveBeenCalled() // OCR was enough
    expect(await repo.listClaims()).toHaveLength(1)
    expect((await verifyAuditChain()).valid).toBe(true)
  })

  it('uses the on-device VLM when OCR is incomplete, and reports that phase', async () => {
    runOcrFallback.mockResolvedValue(ok({ ...hotel, amount: null as never }, 2 / 3))
    const { result, phases } = await run()
    expect(phases).toContain('vlm')
    expect(result.success && result.validated.source).toBe('vlm')
  })

  it('does not link another employee’s trip', async () => {
    const { result } = await run('EMP999')
    expect(result.success && result.built.reconciliation?.status).toBe('UNMATCHED')
  })

  it('retries a transient document-processing failure and then succeeds', async () => {
    processDocument
      .mockReset()
      .mockResolvedValueOnce({ success: false, reason: 'busy' })
      .mockResolvedValueOnce({ success: false, reason: 'busy' })
      .mockResolvedValue(processed)
    const { result } = await run()
    expect(result.success).toBe(true)
    expect(processDocument).toHaveBeenCalledTimes(3)
  })

  it('gives up after 3 attempts with a clear reason and writes no claim', async () => {
    processDocument.mockReset().mockResolvedValue({ success: false, reason: 'corrupt PDF' })
    const { result, phases } = await run()
    expect(result).toEqual({ success: false, reason: 'Document processing failed: corrupt PDF' })
    expect(processDocument).toHaveBeenCalledTimes(3)
    expect(phases.at(-1)).toBe('failed')
    expect(await repo.listClaims()).toHaveLength(0)
  })

  it('retries an extraction step that throws', async () => {
    runOcrFallback.mockReset().mockRejectedValueOnce(new Error('worker died')).mockResolvedValue(ok(hotel))
    const { result } = await run()
    expect(result.success).toBe(true)
    expect(runOcrFallback).toHaveBeenCalledTimes(2)
  })

  it('hands an unreadable receipt to human review instead of inventing a claim', async () => {
    runOcrFallback.mockResolvedValue({ success: false, reason: 'unreadable', latencyMs: 1 })
    extractReceipt.mockResolvedValue({ success: false, reason: 'model missing', latencyMs: 1 })
    const { result } = await run()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.validated.status).toBe('needs_review')
    expect(result.built.claim).toBeNull() // nothing to build a claim from
  })

  it('sees a travel request added after the pipeline was set up (no stale cache)', async () => {
    await resetDb()
    await repo.putPolicySettings({ id: 'default', baseCurrency: 'USD', rates: {} })
    processDocument.mockImplementation(async () => {
      await repo.addTravelRequest({
        requestId: 'TR-LATE', employeeId: 'EMP001', destination: 'Boston',
        startDate: '2026-03-10', endDate: '2026-03-14', approvalStatus: 'approved',
      })
      return processed
    })
    const { result } = await run()
    expect(result.success && result.built.reconciliation?.travelRequestId).toBe('TR-LATE')
  })
})
