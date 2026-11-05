import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionResult } from '../../src/types/extraction'

const runOcrFallback = vi.fn<() => Promise<ExtractionResult>>()
vi.mock('../../src/modules/validation/ocrTextParser', () => ({ runOcrFallback: () => runOcrFallback() }))

const { validateExtraction } = await import('../../src/modules/validation/validateExtraction')

const full = { vendor: 'Cafe', amount: 9.5, currency: 'USD', date: '2026-03-01', lineItems: [] }
const ok = (data = full, confidence = 1): ExtractionResult => ({ success: true, data, confidence, rawModelOutput: '', latencyMs: 1 })
const fail: ExtractionResult = { success: false, reason: 'boom', latencyMs: 1 }
const blob = new Blob(['x'])

describe('Validation gate: OCR first, on-device VLM as fallback', () => {
  beforeEach(() => runOcrFallback.mockReset())

  it('uses a complete OCR read and never starts the slow VLM', async () => {
    runOcrFallback.mockResolvedValue(ok())
    const runVlm = vi.fn()
    const r = await validateExtraction(blob, runVlm)
    expect(r).toMatchObject({ status: 'valid', source: 'ocr', vlmResult: null })
    expect(runVlm).not.toHaveBeenCalled()
  })

  it('falls back to the VLM when OCR is incomplete', async () => {
    runOcrFallback.mockResolvedValue(ok({ ...full, date: null }, 2 / 3))
    const r = await validateExtraction(blob, async () => ok())
    expect(r).toMatchObject({ status: 'valid', source: 'vlm' })
  })

  it('falls back to the VLM when OCR crashes', async () => {
    runOcrFallback.mockResolvedValue(fail)
    const r = await validateExtraction(blob, async () => ok())
    expect(r.source).toBe('vlm')
  })

  it('rejects VLM output with the wrong shape even at full confidence', async () => {
    runOcrFallback.mockResolvedValue(fail)
    const bad = { ...full, amount: '9.50' } as unknown as typeof full
    const r = await validateExtraction(blob, async () => ok(bad))
    expect(r.status).toBe('needs_review')
  })

  it('sends partial data to human review, keeping nulls rather than guessing', async () => {
    runOcrFallback.mockResolvedValue(ok({ ...full, amount: null }, 2 / 3))
    const r = await validateExtraction(blob, async () => fail)
    expect(r.status).toBe('needs_review')
    expect(r.data?.amount).toBeNull()
    expect(r.source).toBe('ocr')
  })

  it('returns no data at all when both paths fail', async () => {
    runOcrFallback.mockResolvedValue(fail)
    const r = await validateExtraction(blob, async () => fail)
    expect(r).toMatchObject({ status: 'needs_review', data: null, source: 'none' })
  })
})
