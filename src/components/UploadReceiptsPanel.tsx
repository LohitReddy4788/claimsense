import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { ingestReceipt } from '../agents/ingestion/ingestReceipt'
import { processDocument } from '../modules/document-processing/processDocument'
import type { ReceiptRecord } from '../types/records'
import type { DetectedFileKind } from '../modules/validation/fileSignature'

interface PreviewState {
  status: 'processing' | 'ready' | 'failed'
  previewUrl?: string
  width?: number
  height?: number
  pageCount?: number
  reason?: string
}

export function UploadReceiptsPanel() {
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})

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
        width: result.width,
        height: result.height,
        pageCount: result.pageCount,
      },
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
