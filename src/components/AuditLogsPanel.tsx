import { useEffect, useState } from 'react'
import { db } from '../modules/storage/db'
import { verifyAuditChain, type ChainVerification } from '../modules/audit/auditLog'
import type { AuditLogRecord } from '../types/records'

interface AuditLogsPanelProps {
  active: boolean
}

export function AuditLogsPanel({ active }: AuditLogsPanelProps) {
  const [entries, setEntries] = useState<AuditLogRecord[]>([])
  const [verification, setVerification] = useState<ChainVerification | null>(null)
  const [verifying, setVerifying] = useState(false)

  async function refresh() {
    const all = await db.auditLogs.orderBy('id').reverse().toArray()
    setEntries(all)
  }

  useEffect(() => {
    if (active) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  async function handleVerify() {
    setVerifying(true)
    const result = await verifyAuditChain()
    setVerification(result)
    setVerifying(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Audit Log ({entries.length})
        </p>
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifying}
          className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {verifying ? 'Verifying…' : 'Verify chain integrity'}
        </button>
      </div>

      {verification && (
        <div
          className={`mt-3 rounded-md px-3 py-2 text-xs ${
            verification.valid
              ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300'
              : 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300'
          }`}
        >
          {verification.valid
            ? `✓ Chain intact — all ${verification.totalEntries} entries verified, no tampering detected.`
            : `⚠ Tampering detected: ${verification.reason}`}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          No actions recorded yet — actions (receipt ingested, claim created/edited/approved) appear here as
          they happen.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="rounded-lg border border-neutral-200 p-3 text-xs dark:border-neutral-800"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{e.action}</span>
                <span className="text-neutral-500 dark:text-neutral-400">
                  {new Date(e.timestamp).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                {e.entityId} — {e.detail}
              </p>
              <p className="mt-1 font-mono text-[10px] text-neutral-400 dark:text-neutral-600">
                hash: {e.currentHash.slice(0, 16)}… ← prev: {e.previousHash.slice(0, 16)}…
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
