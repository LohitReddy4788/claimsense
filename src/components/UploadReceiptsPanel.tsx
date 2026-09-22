import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { saveReceiptFile, hashFile } from '../modules/storage/opfs'
import { generateId } from '../utils/id'
import type { ReceiptRecord } from '../types/records'

export function UploadReceiptsPanel() {
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const all = await db.receipts.orderBy('uploadedAt').reverse().toArray()
    setReceipts(all)
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const receiptId = generateId('rec')
      const opfsPath = await saveReceiptFile(receiptId, file)
      const fileHash = await hashFile(file)
      const record: ReceiptRecord = {
        receiptId,
        fileName: file.name,
        fileType: file.type || 'unknown',
        fileSize: file.size,
        opfsPath,
        fileHash,
        status: 'registered',
        uploadedAt: new Date().toISOString(),
      }
      await db.receipts.add(record)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to store receipt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
        {busy ? 'Saving…' : 'Choose receipt file'}
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

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

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
            {receipts.map((r) => (
              <li key={r.receiptId} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium text-neutral-900 dark:text-neutral-100">{r.fileName}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {r.receiptId} · {(r.fileSize / 1024).toFixed(1)} KB · hash {r.fileHash.slice(0, 10)}…
                  </p>
                </div>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
