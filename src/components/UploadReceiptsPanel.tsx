import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { ingestReceipt } from '../agents/ingestion/ingestReceipt'
import { processDocument } from '../modules/document-processing/processDocument'
import { extractReceipt } from '../agents/extraction/extractReceipt'
import { validateExtraction } from '../modules/validation/validateExtraction'
import { classifyCategory } from '../agents/category/classifyCategory'
import { reconcileTravel } from '../agents/travel/reconcileTravel'
import type { ReceiptRecord } from '../types/records'
import type { DetectedFileKind } from '../modules/validation/fileSignature'
import type { ValidatedReceipt } from '../modules/validation/validateExtraction'
import type { ReconciliationResult } from '../types/reconciliation'

interface PreviewState {
  status: 'processing' | 'ready' | 'failed'
  previewUrl?: string
  blob?: Blob
  width?: number
  height?: number
  pageCount?: number
  reason?: string
}

interface ExtractState {
  status: 'running_vlm' | 'running_fallback' | 'done'
  validated?: ValidatedReceipt
  category?: ReturnType<typeof classifyCategory>
  reconciliation?: ReconciliationResult
}

export function UploadReceiptsPanel() {
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [extractions, setExtractions] = useState<Record<string, ExtractState>>({})
  const [employeeId, setEmployeeId] = useState('EMP001')

  async function refresh() {
    const all = await db.receipts.orderBy('uploadedAt').reverse().toArray()
    setReceipts(all)
  }

  useEffect(() => {
    refresh()
    return () => {
      Object.values(previews).forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runProcessing(receiptId: string, file: File, kind: DetectedFileKind) {
    setPreviews((prev) => ({ ...prev, [receiptId]: { status: 'processing' } }))
    const result = await processDocument(file, kind)
    if (!result.success) {
      setPreviews((prev) => ({
        ...prev,
        [receiptId]: { status: 'failed', reason: result.reason },
      }))
      return
    }
    const previewUrl = URL.createObjectURL(result.blob)
    setPreviews((prev) => ({
      ...prev,
      [receiptId]: {
        status: 'ready',
        previewUrl,
        blob: result.blob,
        width: result.width,
        height: result.height,
        pageCount: result.pageCount,
      },
    }))
  }

  async function runExtraction(receiptId: string, blob: Blob) {
    setExtractions((prev) => ({ ...prev, [receiptId]: { status: 'running_vlm' } }))
    const vlmResult = await extractReceipt(blob)
    setExtractions((prev) => ({ ...prev, [receiptId]: { status: 'running_fallback' } }))
    const validated = await validateExtraction(vlmResult, blob)

    let category: ReturnType<typeof classifyCategory> | undefined
    let reconciliation: ReconciliationResult | undefined
    if (validated.data) {
      category = classifyCategory(validated.data)
      // Fetched fresh here, not cached in component state from mount time —
      // panels stay mounted across the whole session (Phase 5's fix), so a
      // travel request added in another tab after this one mounted would
      // otherwise never be seen. Found this exact bug by testing the real
      // flow: add a travel request, then extract a matching receipt, and
      // watch it wrongly come back unmatched.
      const currentTravelRequests = await db.travelRequests.toArray()
      reconciliation = reconcileTravel(validated.data, employeeId, currentTravelRequests)
    }

    setExtractions((prev) => ({
      ...prev,
      [receiptId]: { status: 'done', validated, category, reconciliation },
    }))
  }

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const result = await ingestReceipt(file)
      if (!result.success) {
        setError(result.reason)
        return
      }
      await refresh()
      // Fire and track separately — a processing failure shouldn't undo a successful ingest.
      runProcessing(result.receipt.receiptId, file, result.receipt.fileType as DetectedFileKind)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to store receipt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
        {busy ? 'Checking…' : 'Choose receipt file'}
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
      </label>
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        PDF, JPEG or PNG only, checked by file content (not just the extension), 15MB max.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <label className="text-sm text-neutral-600 dark:text-neutral-300" htmlFor="employeeId">
          Claiming as employee:
        </label>
        <input
          id="employeeId"
          className="w-32 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
        />
        <span className="text-xs text-neutral-400">
          — receipts don't print an employee ID, so this is who the claim is for
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Rejected: {error}
        </p>
      )}

      <div className="mt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Stored receipts ({receipts.length})
        </p>
        {receipts.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Nothing uploaded yet. Files are saved to OPFS; the record below is saved to IndexedDB.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
            {receipts.map((r) => {
              const preview = previews[r.receiptId]
              return (
                <li key={r.receiptId} className="flex items-start gap-3 py-3 text-sm">
                  <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
                    {preview?.status === 'ready' && preview.previewUrl ? (
                      <img src={preview.previewUrl} alt="" className="h-full w-full object-cover" />
                    ) : preview?.status === 'processing' ? (
                      <span className="text-xs text-neutral-400">…</span>
                    ) : preview?.status === 'failed' ? (
                      <span className="text-xs text-red-500" title={preview.reason}>
                        !
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-300 dark:text-neutral-600">—</span>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-neutral-900 dark:text-neutral-100">{r.fileName}</p>
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {r.status}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {r.receiptId} · {r.fileType} · {(r.fileSize / 1024).toFixed(1)} KB · hash{' '}
                      {r.fileHash.slice(0, 10)}…
                    </p>
                    {preview?.status === 'ready' && (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        Processed: {preview.width}×{preview.height}px
                        {preview.pageCount && preview.pageCount > 1 ? ` · ${preview.pageCount} pages` : ''}
                      </p>
                    )}
                    {preview?.status === 'failed' && (
                      <p className="text-xs text-red-600 dark:text-red-400">
                        Processing failed: {preview.reason}
                      </p>
                    )}
                    {preview?.status === 'ready' && preview.blob && (
                      <div className="mt-2">
                        {!extractions[r.receiptId] && (
                          <button
                            type="button"
                            onClick={() => runExtraction(r.receiptId, preview.blob!)}
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                          >
                            Extract with on-device AI
                          </button>
                        )}
                        {extractions[r.receiptId]?.status === 'running_vlm' && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Running on-device model… (first run loads ~500MB, can take a while)
                          </p>
                        )}
                        {extractions[r.receiptId]?.status === 'running_fallback' && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Validating result…
                          </p>
                        )}
                        {extractions[r.receiptId]?.status === 'done' &&
                          (() => {
                            const validated = extractions[r.receiptId].validated!
                            const badgeClass =
                              validated.status === 'valid'
                                ? 'bg-green-50 dark:bg-green-950'
                                : 'bg-amber-50 dark:bg-amber-950'
                            return (
                              <div className={`rounded-md ${badgeClass} px-2 py-1.5 text-xs text-neutral-700 dark:text-neutral-300`}>
                                <p className="font-medium">
                                  {validated.status === 'valid' ? '✓ Valid' : '⚠ Needs review'} · source:{' '}
                                  {validated.source === 'vlm'
                                    ? 'on-device AI'
                                    : validated.source === 'ocr_fallback'
                                      ? 'OCR fallback'
                                      : 'none'}
                                </p>
                                <p>
                                  AI: {(validated.vlmResult.success ? validated.vlmResult.confidence * 100 : 0).toFixed(0)}%
                                  confidence
                                  {validated.fallbackResult && (
                                    <>
                                      {' '}
                                      · OCR fallback ran (
                                      {validated.fallbackResult.success
                                        ? `${(validated.fallbackResult.confidence * 100).toFixed(0)}% confidence`
                                        : 'failed'}
                                      )
                                    </>
                                  )}
                                </p>
                                {validated.data ? (
                                  <>
                                    <p>vendor: {validated.data.vendor ?? '—'}</p>
                                    <p>
                                      amount: {validated.data.amount ?? '—'} {validated.data.currency ?? ''}
                                    </p>
                                    <p>date: {validated.data.date ?? '—'}</p>
                                    {extractions[r.receiptId].category &&
                                      (() => {
                                        const cat = extractions[r.receiptId].category!
                                        return (
                                          <p>
                                            category: {cat.category}
                                            {cat.category !== 'Other' && ` (${(cat.confidence * 100).toFixed(0)}%)`}
                                          </p>
                                        )
                                      })()}
                                    {extractions[r.receiptId].reconciliation &&
                                      (() => {
                                        const recon = extractions[r.receiptId].reconciliation!
                                        const reconLabel =
                                          recon.status === 'MATCHED'
                                            ? '✓ matched'
                                            : recon.status === 'REVIEW'
                                              ? '⚠ review'
                                              : '— unmatched'
                                        return (
                                          <p title={recon.reason}>
                                            travel: {reconLabel}
                                            {recon.travelRequestId && ` (${recon.travelRequestId})`}
                                          </p>
                                        )
                                      })()}
                                  </>
                                ) : (
                                  <p>No usable data from either extraction path.</p>
                                )}
                              </div>
                            )
                          })()}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
