import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Loader2, History, Link2, Hash } from 'lucide-react'
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Audit Log ({entries.length})
        </p>
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifying}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-brand-800 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
        >
          {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} />}
          {verifying ? 'Verifying…' : 'Verify chain integrity'}
        </button>
      </div>

      {verification && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-xl px-3.5 py-3 text-xs ${
            verification.valid
              ? 'bg-green-50 text-green-800 dark:bg-green-950/60 dark:text-green-300'
              : 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300'
          }`}
        >
          {verification.valid ? (
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
          ) : (
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
          )}
          <p>
            {verification.valid
              ? `Chain intact — all ${verification.totalEntries} entries verified, no tampering detected.`
              : `Tampering detected: ${verification.reason}`}
          </p>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50/60 py-12 text-center dark:border-neutral-800 dark:bg-neutral-900/40">
          <History className="h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.5} />
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No actions recorded yet — actions (receipt ingested, claim created/edited/approved) appear here as
            they happen.
          </p>
        </div>
      ) : (
        <ul className="relative mt-4 space-y-0">
          {entries.map((e, i) => (
            <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
              {i !== entries.length - 1 && (
                <span className="absolute left-[13px] top-6 h-[calc(100%-14px)] w-px bg-neutral-200 dark:bg-neutral-800" />
              )}
              <div className="z-10 flex h-7 w-7 flex-none items-center justify-center rounded-full border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
                <Link2 className="h-3.5 w-3.5 text-neutral-400" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{e.action}</span>
                  <span className="text-neutral-500 dark:text-neutral-400">
                    {new Date(e.timestamp).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                  {e.entityId} — {e.detail}
                </p>
                <p className="mt-1.5 flex items-center gap-1 font-mono text-[10px] text-neutral-400 dark:text-neutral-600">
                  <Hash className="h-3 w-3 flex-none" strokeWidth={2} />
                  {e.currentHash.slice(0, 16)}… ← prev: {e.previousHash.slice(0, 16)}…
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
