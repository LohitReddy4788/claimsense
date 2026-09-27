import { useEffect, useRef, useState } from 'react'
import { db } from '../modules/storage/db'
import { ingestReceipt } from '../agents/ingestion/ingestReceipt'
import { processDocument } from '../modules/document-processing/processDocument'
import { readReceiptFile } from '../modules/storage/opfs'
import { runOrchestrator, type OrchestratorPhase } from '../agents/orchestrator/runOrchestrator'
import type { ReceiptRecord } from '../types/records'
import type { DetectedFileKind } from '../modules/validation/fileSignature'
import type { ValidatedReceipt } from '../modules/validation/validateExtraction'
import type { BuiltResult } from '../agents/orchestrator/orchestratorMachine'

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
  status: OrchestratorPhase
  validated?: ValidatedReceipt
  built?: BuiltResult
  failureReason?: string
}

export function UploadReceiptsPanel() {
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [extractions, setExtractions] = useState<Record<string, ExtractState>>({})
  const [employeeId, setEmployeeId] = useState('EMP001')
  // Kept so "Extract" can hand the original File to the Orchestrator,
  // which does its own document-processing step (with retries) rather
  // than reusing the thumbnail's already-processed blob — the thumbnail
  // preview and the orchestrator's pipeline are deliberately independent,
  // so a flaky thumbnail render doesn't block a retry-capable real run.
  const [files, setFiles] = useState<Record<string, File>>({})
  // Tracks which receipts we've already tried to restore from OPFS this
  // session, so a reload doesn't repeat the read/reprocess on every
  // refresh() call — a ref rather than state because it's bookkeeping,
  // not something that should trigger a re-render on its own.
  const restoredRef = useRef<Set<string>>(new Set())

  async function refresh() {
    const all = await db.receipts.orderBy('uploadedAt').reverse().toArray()
    setReceipts(all)

    // Found live (2026-09-24): after a page reload, `files` and `previews`
    // reset to empty — they only ever lived in this component's memory,
    // never persisted — which silently removed the "Extract" button and
    // thumbnail from any receipt that hadn't been extracted yet, even
    // though the receipt record AND its actual file bytes were both still
    // safely in IndexedDB/OPFS the whole time (Phase 1's own guarantee).
    // The fix: read the file back from OPFS (where ingestReceipt already
    // saved it) and re-populate both, restoring full functionality
    // without asking the user to re-upload something already saved.
    for (const receipt of all) {
      if (restoredRef.current.has(receipt.receiptId)) continue
      restoredRef.current.add(receipt.receiptId)
      try {
        const file = await readReceiptFile(receipt.receiptId)
        setFiles((prev) => ({ ...prev, [receipt.receiptId]: file }))
        // runProcessing does its own setPreviews calls internally — called
        // directly here, not from inside a state updater, since updater
        // functions can run more than once under StrictMode and shouldn't
        // trigger side effects. restoredRef above already guarantees this
        // whole block runs at most once per receiptId, so no extra guard
        // is needed here.
        runProcessing(receipt.receiptId, file, receipt.fileType as DetectedFileKind)
      } catch (e) {
        // The receipt record exists but its file is missing from OPFS —
        // a genuinely unexpected state, not one to guess around. Leave
        // this receipt's preview/extract button absent rather than
        // pretending a restore succeeded.
        console.error(`Could not restore file for receipt ${receipt.receiptId}:`, e)
      }
    }
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

  // Delegates the whole processing→extraction→classify→reconcile→policy→
  // claim pipeline to the Orchestrator Agent (Phase 14) instead of running
  // each step inline here — the Orchestrator owns retries (document
  // processing and extraction each get up to 2 automatic retries on a
  // genuine failure before routing to a 'failed' state) and merging
  // results. onPhaseChange just updates the same small set of UI states
  // this panel already had before the Orchestrator existed.
  async function runExtraction(receiptId: string, fileHash: string, kind: DetectedFileKind) {
    const file = files[receiptId]
    setExtractions((prev) => ({ ...prev, [receiptId]: { status: 'processing' } }))
    const result = await runOrchestrator(
      { receiptId, fileHash, file, kind, employeeId },
      (phase) => setExtractions((prev) => ({ ...prev, [receiptId]: { ...prev[receiptId], status: phase } })),
    )
    if (result.success) {
      setExtractions((prev) => ({
        ...prev,
        [receiptId]: { status: 'done', validated: result.validated, built: result.built },
      }))
    } else {
      setExtractions((prev) => ({
        ...prev,
        [receiptId]: { status: 'failed', failureReason: result.reason },
      }))
    }
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
      // Mark restored BEFORE refresh() so its OPFS-restoration pass (which
      // would otherwise not yet see this receipt in `files`/`previews`,
      // since those two setState calls below haven't run yet) doesn't
      // redundantly re-read the file we already have in hand and process
      // it a second time in parallel.
      restoredRef.current.add(result.receipt.receiptId)
      await refresh()
      setFiles((prev) => ({ ...prev, [result.receipt.receiptId]: file }))
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
                    {files[r.receiptId] && (
                      <div className="mt-2">
                        {!extractions[r.receiptId] && (
                          <button
                            type="button"
                            onClick={() => runExtraction(r.receiptId, r.fileHash, r.fileType as DetectedFileKind)}
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                          >
                            Extract with on-device AI
                          </button>
                        )}
                        {extractions[r.receiptId]?.status === 'processing' && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Preparing document…
                          </p>
                        )}
                        {extractions[r.receiptId]?.status === 'ocr' && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Reading text (OCR)…
                          </p>
                        )}
                        {extractions[r.receiptId]?.status === 'vlm' && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            OCR wasn't confident enough — running the on-device AI model instead…
                            (first run loads ~500MB, can take a while)
                          </p>
                        )}
                        {extractions[r.receiptId]?.status === 'building' && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            Classifying, matching travel, checking policy…
                          </p>
                        )}
                        {extractions[r.receiptId]?.status === 'failed' && (
                          <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                            <p className="font-medium">⚠ Failed after automatic retries</p>
                            <p>{extractions[r.receiptId].failureReason}</p>
                            <button
                              type="button"
                              onClick={() =>
                                setExtractions((prev) => {
                                  const next = { ...prev }
                                  delete next[r.receiptId]
                                  return next
                                })
                              }
                              className="mt-1 rounded-md border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
                            >
                              Try again
                            </button>
                          </div>
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
                                  {validated.source === 'ocr'
                                    ? 'OCR'
                                    : validated.source === 'vlm'
                                      ? 'on-device AI'
                                      : 'none'}
                                </p>
                                <p>
                                  OCR: {(validated.ocrResult.success ? validated.ocrResult.confidence * 100 : 0).toFixed(0)}%
                                  confidence
                                  {validated.vlmResult && (
                                    <>
                                      {' '}
                                      · on-device AI ran (
                                      {validated.vlmResult.success
                                        ? `${(validated.vlmResult.confidence * 100).toFixed(0)}% confidence`
                                        : 'failed'}
                                      )
                                      {validated.vlmResult.device === 'wasm' && (
                                        <span className="text-amber-600 dark:text-amber-400">
                                          {' '}
                                          · CPU fallback (WASM) — no GPU acceleration detected on this device, which
                                          is why this took longer than the ~4 minute baseline
                                        </span>
                                      )}
                                      {validated.vlmResult.device === 'webgpu' && ' · GPU-accelerated (WebGPU)'}
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
                                    {extractions[r.receiptId].built?.category &&
                                      (() => {
                                        const cat = extractions[r.receiptId].built!.category!
                                        return (
                                          <p>
                                            category: {cat.category}
                                            {cat.category !== 'Other' && ` (${(cat.confidence * 100).toFixed(0)}%)`}
                                          </p>
                                        )
                                      })()}
                                    {extractions[r.receiptId].built?.reconciliation &&
                                      (() => {
                                        const recon = extractions[r.receiptId].built!.reconciliation!
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
                                    {extractions[r.receiptId].built?.policy &&
                                      (() => {
                                        const pol = extractions[r.receiptId].built!.policy!
                                        const polLabel =
                                          pol.status === 'PASS'
                                            ? '✓ pass'
                                            : pol.status === 'VIOLATION'
                                              ? '✗ violation'
                                              : '⚠ review'
                                        return (
                                          <p title={pol.message}>
                                            policy: {polLabel}
                                            {pol.reasonCode && ` (${pol.reasonCode})`}
                                          </p>
                                        )
                                      })()}
                                    {extractions[r.receiptId].built?.claim &&
                                      (() => {
                                        const claim = extractions[r.receiptId].built!.claim!
                                        return (
                                          <p className="font-medium">
                                            claim: {claim.status === 'draft' ? '✓ draft' : '⚠ needs review'}
                                            {claim.duplicateOfClaimId &&
                                              ` — possible duplicate of ${claim.duplicateOfClaimId}`}
                                            {claim.lineItemReviewReason && ` — ${claim.lineItemReviewReason}`}
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
