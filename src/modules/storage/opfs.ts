const RECEIPTS_DIR = 'receipts'

async function getReceiptsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(RECEIPTS_DIR, { create: true })
}

export async function saveReceiptFile(receiptId: string, file: File): Promise<string> {
  const dir = await getReceiptsDir()
  const handle = await dir.getFileHandle(receiptId, { create: true })
  const writable = await handle.createWritable()
  await writable.write(file)
  await writable.close()
  return `${RECEIPTS_DIR}/${receiptId}`
}

export async function readReceiptFile(receiptId: string): Promise<File> {
  const dir = await getReceiptsDir()
  const handle = await dir.getFileHandle(receiptId)
  return handle.getFile()
}

export async function deleteReceiptFile(receiptId: string): Promise<void> {
  const dir = await getReceiptsDir()
  await dir.removeEntry(receiptId)
}

export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Deletes every stored receipt file (the whole receipts folder). */
export async function deleteAllReceiptFiles(): Promise<void> {
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(RECEIPTS_DIR, { recursive: true })
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
  }
}
