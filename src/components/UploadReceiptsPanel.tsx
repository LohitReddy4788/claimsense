import { useEffect, useRef, useState } from 'react'
import {
  UploadCloud,
  User,
  FileText,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  ScanText,
  Cog,
  RotateCcw,
  Plane,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  CircleAlert,
  XCircle,
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
      <div className="flex flex-col gap-4 rounded-2xl border border-dashed border-white/25 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-white/40">
            <UploadCloud className="h-5 w-5 text-white" strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Add a receipt</p>
            <p className="text-xs text-white/50">
              PDF, JPEG or PNG · checked by file content, not the extension · 15MB max
            </p>
          </div>
        </div>
        <label className="inline-flex flex-none cursor-pointer items-center justify-center gap-2 rounded-lg border border-white bg-white px-4 py-2.5 text-sm font-medium text-black transition-colors hover:bg-white/90 active:bg-white/80">
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

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/20 px-4 py-3">
        <User className="h-4 w-4 flex-none text-white/50" strokeWidth={1.75} />
        <label className="text-sm font-medium text-white/80" htmlFor="employeeId">
          Claiming as
        </label>
        <input
          id="employeeId"
          className="w-32 rounded-md border border-white/25 bg-black px-2 py-1 text-sm text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
        />
        <span className="text-xs text-white/40">
          receipts don't print an employee ID, so this is who the claim is for
        </span>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-white px-3.5 py-3 text-sm text-white">
          <CircleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          <p>
            <span className="font-semibold">Rejected:</span> {error}
          </p>
        </div>
      )}

      <div className="mt-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
          Stored receipts ({receipts.length})
        </p>
        {receipts.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
            <FileText className="h-8 w-8 text-white/25" strokeWidth={1.5} />
            <p className="text-sm text-white/50">
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
                  className="flex items-start gap-4 rounded-2xl border border-white/15 p-4"
                >
                  <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded-xl border border-white/20">
                    {preview?.status === 'ready' && preview.previewUrl ? (
                      <img src={preview.previewUrl} alt="" className="h-full w-full object-cover" />
                    ) : preview?.status === 'processing' ? (
                      <Loader2 className="h-5 w-5 animate-spin text-white/50" strokeWidth={1.75} />
                    ) : preview?.status === 'failed' ? (
                      <AlertTriangle className="h-5 w-5 text-white" strokeWidth={1.75} />
                    ) : (
                      <FileText className="h-5 w-5 text-white/25" strokeWidth={1.5} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-medium text-white">{r.fileName}</p>
                      <span className="flex-none rounded-full border border-white/30 px-2.5 py-0.5 text-xs font-medium text-white/70">
                        {r.status}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-white/50">
                      {r.receiptId} · {r.fileType} · {(r.fileSize / 1024).toFixed(1)} KB · hash{' '}
                      {r.fileHash.slice(0, 10)}…
                    </p>
                    {preview?.status === 'ready' && (
                      <p className="mt-0.5 text-xs text-white/50">
                        Processed: {preview.width}×{preview.height}px
                        {preview.pageCount && preview.pageCount > 1 ? ` · ${preview.pageCount} pages` : ''}
                      </p>
                    )}
                    {preview?.status === 'failed' && (
                      <p className="mt-0.5 text-xs text-white/70">
                        Processing failed: {preview.reason}
                      </p>
                    )}
                    {files[r.receiptId] && (
                      <div className="mt-3">
                        {!extraction && (
                          <button
                            type="button"
                            onClick={() => runExtraction(r.receiptId, r.fileHash, r.fileType as DetectedFileKind)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
                          >
                            <Cpu className="h-3.5 w-3.5" strokeWidth={1.75} />
                            Extract with on-device AI
                          </button>
                        )}
                        {extraction?.status === 'processing' && (
                          <p className="inline-flex items-center gap-1.5 text-xs text-white/60">
                            <Cog className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                            Preparing document…
                          </p>
                        )}
                        {extraction?.status === 'ocr' && (
                          <p className="inline-flex items-center gap-1.5 text-xs text-white/60">
                            <ScanText className="h-3.5 w-3.5 animate-pulse" strokeWidth={1.75} />
                            Reading text (OCR)…
                          </p>
                        )}
                        {extraction?.status === 'vlm' && (
                          <p className="inline-flex items-start gap-1.5 text-xs text-white/60">
                            <Cpu className="mt-0.5 h-3.5 w-3.5 flex-none animate-pulse" strokeWidth={1.75} />
                            <span>
                              OCR wasn't confident enough — running the on-device AI model instead… (first run
                              loads ~500MB, can take a while)
                            </span>
                          </p>
                        )}
                        {extraction?.status === 'building' && (
                          <p className="inline-flex items-center gap-1.5 text-xs text-white/60">
                            <Cog className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                            Classifying, matching travel, checking policy…
                          </p>
                        )}
                        {extraction?.status === 'failed' && (
                          <div className="rounded-xl border border-white px-3 py-2.5 text-xs text-white">
                            <p className="flex items-center gap-1.5 font-semibold">
                              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.75} />
                              Failed after automatic retries
                            </p>
                            <p className="mt-0.5 text-white/70">{extraction.failureReason}</p>
                            <button
                              type="button"
                              onClick={() =>
                                setExtractions((prev) => {
                                  const next = { ...prev }
                                  delete next[r.receiptId]
                                  return next
                                })
                              }
                              className="mt-2 inline-flex items-center gap-1 rounded-md border border-white/40 px-2 py-1 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/10"
                            >
                              <RotateCcw className="h-3 w-3" strokeWidth={1.75} />
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
                              <div className="rounded-xl border border-white/25 px-3.5 py-3 text-xs text-white/80">
                                <p className="flex items-center gap-1.5 font-semibold text-white">
                                  {isValid ? (
                                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                                  ) : (
                                    <ShieldQuestion className="h-3.5 w-3.5" strokeWidth={1.75} />
                                  )}
                                  {isValid ? 'Valid' : 'Needs review'}
                                  <span className="font-normal text-white/50">
                                    · source: {validated.source === 'ocr' ? 'OCR' : validated.source === 'vlm' ? 'on-device AI' : 'none'}
                                  </span>
                                </p>
                                <p className="mt-1.5">
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
                                        <span className="text-white">
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
                                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                                    <div className="col-span-2 sm:col-span-1">
                                      <dt className="text-[10px] uppercase tracking-wide text-white/40">Vendor</dt>
                                      <dd className="truncate font-medium text-white">{validated.data.vendor ?? '—'}</dd>
                                    </div>
                                    <div>
                                      <dt className="text-[10px] uppercase tracking-wide text-white/40">Amount</dt>
                                      <dd className="font-medium text-white">
                                        {validated.data.amount ?? '—'} {validated.data.currency ?? ''}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-[10px] uppercase tracking-wide text-white/40">Date</dt>
                                      <dd className="font-medium text-white">{validated.data.date ?? '—'}</dd>
                                    </div>
                                    {built?.category && (
                                      <div>
                                        <dt className="text-[10px] uppercase tracking-wide text-white/40">Category</dt>
                                        <dd className="font-medium text-white">
                                          {built.category.category}
                                          {built.category.category !== 'Other' &&
                                            ` (${(built.category.confidence * 100).toFixed(0)}%)`}
                                        </dd>
                                      </div>
                                    )}
                                    {built?.reconciliation && (
                                      <div title={built.reconciliation.reason}>
                                        <dt className="text-[10px] uppercase tracking-wide text-white/40">Travel</dt>
                                        <dd className="flex items-center gap-1 font-medium text-white">
                                          <Plane className="h-3 w-3 flex-none" strokeWidth={1.75} />
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
                                        <dt className="text-[10px] uppercase tracking-wide text-white/40">Policy</dt>
                                        <dd className="flex items-center gap-1 font-medium text-white">
                                          {built.policy.status === 'PASS' ? (
                                            <ShieldCheck className="h-3 w-3 flex-none" strokeWidth={1.75} />
                                          ) : built.policy.status === 'VIOLATION' ? (
                                            <ShieldAlert className="h-3 w-3 flex-none" strokeWidth={1.75} />
                                          ) : (
                                            <ShieldQuestion className="h-3 w-3 flex-none" strokeWidth={1.75} />
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
                                  <p className="mt-2 text-white/70">
                                    No usable data from either extraction path.
                                  </p>
                                )}
                                {built?.claim && (
                                  <p className="mt-2.5 flex items-start gap-1.5 border-t border-white/20 pt-2 font-semibold text-white">
                                    {built.claim.status === 'draft' ? (
                                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                                    ) : (
                                      <XCircle className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
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
