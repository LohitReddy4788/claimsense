import { useEffect, useRef, useState } from 'react'
import {
  UploadCloud,
  User,
  FileText,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  ScanText,
  Cog,
  RotateCcw,
  Plane,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  CircleAlert,
} from 'lucide-react'
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
      <div className="flex flex-col gap-4 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/60 p-6 dark:border-neutral-700 dark:bg-neutral-800/30 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-950/40">
            <UploadCloud className="h-5 w-5 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Add a receipt</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              PDF, JPEG or PNG · checked by file content, not the extension · 15MB max
            </p>
          </div>
        </div>
        <label className="inline-flex flex-none cursor-pointer items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700 active:bg-brand-800">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} /> : <UploadCloud className="h-4 w-4" strokeWidth={2.25} />}
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
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <User className="h-4 w-4 flex-none text-neutral-400" strokeWidth={2} />
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300" htmlFor="employeeId">
          Claiming as
        </label>
        <input
          id="employeeId"
          className="w-32 rounded-md border border-neutral-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-neutral-700 dark:bg-neutral-950"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
        />
        <span className="text-xs text-neutral-400">
          receipts don't print an employee ID, so this is who the claim is for
        </span>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-sm text-red-700 dark:bg-red-950/60 dark:text-red-300">
          <CircleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
          <p>
            <span className="font-medium">Rejected:</span> {error}
          </p>
        </div>
      )}

      <div className="mt-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Stored receipts ({receipts.length})
        </p>
        {receipts.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50/60 py-12 text-center dark:border-neutral-800 dark:bg-neutral-900/40">
            <FileText className="h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Nothing uploaded yet. Files are saved to OPFS; the record is saved to IndexedDB.
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {receipts.map((r) => {
              const preview = previews[r.receiptId]
              const extraction = extractions[r.receiptId]
              return (
                <li
                  key={r.receiptId}
                  className="flex items-start gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
                    {preview?.status === 'ready' && preview.previewUrl ? (
                      <img src={preview.previewUrl} alt="" className="h-full w-full object-cover" />
                    ) : preview?.status === 'processing' ? (
                      <Loader2 className="h-5 w-5 animate-spin text-neutral-400" strokeWidth={2} />
                    ) : preview?.status === 'failed' ? (
                      <AlertTriangle className="h-5 w-5 text-red-500" strokeWidth={2} />
                    ) : (
                      <FileText className="h-5 w-5 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">{r.fileName}</p>
                      <span className="flex-none rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {r.status}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {r.receiptId} · {r.fileType} · {(r.fileSize / 1024).toFixed(1)} KB · hash{' '}
                      {r.fileHash.slice(0, 10)}…
                    </p>
                    {preview?.status === 'ready' && (
                      <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                        Processed: {preview.width}×{preview.height}px
                        {preview.pageCount && preview.pageCount > 1 ? ` · ${preview.pageCount} pages` : ''}
                      </p>
                    )}
                    {preview?.status === 'failed' && (
                      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">
                        Processing failed: {preview.reason}
                      </p>
                    )}
                    {files[r.receiptId] && (
                      <div className="mt-3">
                        {!extraction && (
                          <button
                            type="button"
                            onClick={() => runExtraction(r.receiptId, r.fileHash, r.fileType as DetectedFileKind)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
                          >
                            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
                            Extract with on-device AI
                          </button>
                        )}
                        {extraction?.status === 'processing' && (
                          <p className="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                            <Cog className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                            Preparing document…
                          </p>
                        )}
                        {extraction?.status === 'ocr' && (
                          <p className="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                            <ScanText className="h-3.5 w-3.5 animate-pulse" strokeWidth={2} />
                            Reading text (OCR)…
                          </p>
                        )}
                        {extraction?.status === 'vlm' && (
                          <p className="inline-flex items-start gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                            <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-none animate-pulse text-brand-500" strokeWidth={2} />
                            <span>
                              OCR wasn't confident enough — running the on-device AI model instead… (first run
                              loads ~500MB, can take a while)
                            </span>
                          </p>
                        )}
                        {extraction?.status === 'building' && (
                          <p className="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                            <Cog className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                            Classifying, matching travel, checking policy…
                          </p>
                        )}
                        {extraction?.status === 'failed' && (
                          <div className="rounded-xl bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:bg-red-950/60 dark:text-red-300">
                            <p className="flex items-center gap-1.5 font-medium">
                              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
                              Failed after automatic retries
                            </p>
                            <p className="mt-0.5">{extraction.failureReason}</p>
                            <button
                              type="button"
                              onClick={() =>
                                setExtractions((prev) => {
                                  const next = { ...prev }
                                  delete next[r.receiptId]
                                  return next
                                })
                              }
                              className="mt-2 inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900"
                            >
                              <RotateCcw className="h-3 w-3" strokeWidth={2} />
                              Try again
                            </button>
                          </div>
                        )}
                        {extraction?.status === 'done' &&
                          (() => {
                            const validated = extraction.validated!
                            const built = extraction.built
                            const isValid = validated.status === 'valid'
                            return (
                              <div
                                className={`rounded-xl border px-3.5 py-3 text-xs ${
                                  isValid
                                    ? 'border-green-200 bg-green-50/70 dark:border-green-900 dark:bg-green-950/40'
                                    : 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/40'
                                }`}
                              >
                                <p
                                  className={`flex items-center gap-1.5 font-medium ${
                                    isValid ? 'text-green-800 dark:text-green-300' : 'text-amber-800 dark:text-amber-300'
                                  }`}
                                >
                                  {isValid ? (
                                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                                  ) : (
                                    <ShieldQuestion className="h-3.5 w-3.5" strokeWidth={2} />
                                  )}
                                  {isValid ? 'Valid' : 'Needs review'}
                                  <span className="font-normal text-neutral-500 dark:text-neutral-400">
                                    · source: {validated.source === 'ocr' ? 'OCR' : validated.source === 'vlm' ? 'on-device AI' : 'none'}
                                  </span>
                                </p>
                                <p className="mt-1.5 text-neutral-600 dark:text-neutral-300">
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
                                          · CPU fallback (WASM) — no GPU acceleration detected on this device,
                                          which is why this took noticeably longer than usual
                                        </span>
                                      )}
                                      {validated.vlmResult.device === 'webgpu' && ' · GPU-accelerated (WebGPU)'}
                                    </>
                                  )}
                                </p>
                                {validated.data ? (
                                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-neutral-700 dark:text-neutral-300">
                                    <div className="col-span-2 sm:col-span-1">
                                      <dt className="text-[10px] uppercase tracking-wide text-neutral-400">Vendor</dt>
                                      <dd className="truncate font-medium">{validated.data.vendor ?? '—'}</dd>
                                    </div>
                                    <div>
                                      <dt className="text-[10px] uppercase tracking-wide text-neutral-400">Amount</dt>
                                      <dd className="font-medium">
                                        {validated.data.amount ?? '—'} {validated.data.currency ?? ''}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-[10px] uppercase tracking-wide text-neutral-400">Date</dt>
                                      <dd className="font-medium">{validated.data.date ?? '—'}</dd>
                                    </div>
                                    {built?.category && (
                                      <div>
                                        <dt className="text-[10px] uppercase tracking-wide text-neutral-400">Category</dt>
                                        <dd className="font-medium">
                                          {built.category.category}
                                          {built.category.category !== 'Other' &&
                                            ` (${(built.category.confidence * 100).toFixed(0)}%)`}
                                        </dd>
                                      </div>
                                    )}
                                    {built?.reconciliation && (
                                      <div title={built.reconciliation.reason}>
                                        <dt className="text-[10px] uppercase tracking-wide text-neutral-400">Travel</dt>
                                        <dd className="flex items-center gap-1 font-medium">
                                          <Plane className="h-3 w-3 flex-none" strokeWidth={2} />
                                          {built.reconciliation.status === 'MATCHED'
                                            ? 'Matched'
                                            : built.reconciliation.status === 'REVIEW'
                                              ? 'Review'
                                              : 'Unmatched'}
                                          {built.reconciliation.travelRequestId && ` (${built.reconciliation.travelRequestId})`}
                                        </dd>
                                      </div>
                                    )}
                                    {built?.policy && (
                                      <div title={built.policy.message}>
                                        <dt className="text-[10px] uppercase tracking-wide text-neutral-400">Policy</dt>
                                        <dd className="flex items-center gap-1 font-medium">
                                          {built.policy.status === 'PASS' ? (
                                            <ShieldCheck className="h-3 w-3 flex-none text-green-600 dark:text-green-400" strokeWidth={2} />
                                          ) : built.policy.status === 'VIOLATION' ? (
                                            <ShieldAlert className="h-3 w-3 flex-none text-red-600 dark:text-red-400" strokeWidth={2} />
                                          ) : (
                                            <ShieldQuestion className="h-3 w-3 flex-none text-amber-600 dark:text-amber-400" strokeWidth={2} />
                                          )}
                                          {built.policy.status === 'PASS'
                                            ? 'Pass'
                                            : built.policy.status === 'VIOLATION'
                                              ? 'Violation'
                                              : 'Review'}
                                          {built.policy.reasonCode && ` (${built.policy.reasonCode})`}
                                        </dd>
                                      </div>
                                    )}
                                  </dl>
                                ) : (
                                  <p className="mt-2 text-neutral-600 dark:text-neutral-300">
                                    No usable data from either extraction path.
                                  </p>
                                )}
                                {built?.claim && (
                                  <p
                                    className={`mt-2.5 flex items-start gap-1.5 border-t pt-2 font-medium ${
                                      built.claim.status === 'draft'
                                        ? 'border-green-200 text-green-700 dark:border-green-900 dark:text-green-300'
                                        : 'border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-300'
                                    }`}
                                  >
                                    {built.claim.status === 'draft' ? (
                                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={2} />
                                    ) : (
                                      <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={2} />
                                    )}
                                    <span>
                                      Claim: {built.claim.status === 'draft' ? 'draft' : 'needs review'}
                                      {built.claim.duplicateOfClaimId &&
                                        ` — possible duplicate of ${built.claim.duplicateOfClaimId}`}
                                      {built.claim.lineItemReviewReason && ` — ${built.claim.lineItemReviewReason}`}
                                    </span>
                                  </p>
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
