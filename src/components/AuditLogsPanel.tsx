import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Loader2, History, Link2, Hash } from 'lucide-react'
import * as repo from '../modules/storage/repository'
import { verifyAuditChain, type ChainVerification } from '../modules/audit/auditLog'
import { LoadingState, errorText } from './LoadingState'
import type { AuditLogRecord } from '../types/records'

interface AuditLogsPanelProps {
  active: boolean
}

export function AuditLogsPanel({ active }: AuditLogsPanelProps) {
  const [entries, setEntries] = useState<AuditLogRecord[]>([])
  const [verification, setVerification] = useState<ChainVerification | null>(null)
  const [verifying, setVerifying] = useState(false)

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function refresh() {
    try {
      const all = await repo.listAuditLogs('desc')
      setEntries(all)
      setLoaded(true)
      setLoadError(null)
    } catch (err) {
      console.error('AuditLogsPanel refresh failed:', err)
      setLoadError(errorText(err))
    }
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
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">
          Audit Log ({loaded ? entries.length : '…'})
        </p>
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifying}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />}
          {verifying ? 'Verifying…' : 'Verify chain integrity'}
        </button>
      </div>

      {verification && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-white px-3.5 py-3 text-xs text-white">
          {verification.valid ? (
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          ) : (
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          )}
          <p>
            {verification.valid
              ? `Chain intact — all ${verification.totalEntries} entries verified, no tampering detected.`
              : `Tampering detected: ${verification.reason}`}
          </p>
        </div>
      )}

      {!loaded ? (
        <LoadingState error={loadError} />
      ) : entries.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
          <History className="h-8 w-8 text-white/25" strokeWidth={1.5} />
          <p className="text-sm text-white/50">
            No actions recorded yet — actions (receipt ingested, claim created/edited/approved) appear here as
            they happen.
          </p>
        </div>
      ) : (
        <ul className="relative mt-4 space-y-0">
          {entries.map((e, i) => (
            <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
              {i !== entries.length - 1 && (
                <span className="absolute left-[13px] top-6 h-[calc(100%-14px)] w-px bg-white/15" />
              )}
              <div className="z-10 flex h-7 w-7 flex-none items-center justify-center rounded-full border border-white/30 bg-black">
                <Link2 className="h-3.5 w-3.5 text-white/60" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1 rounded-xl border border-white/15 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="font-medium text-white">{e.action}</span>
                  <span className="text-white/50">{new Date(e.timestamp).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-white/60">
                  {e.entityId} — {e.detail}
                </p>
                <p className="mt-1.5 flex items-center gap-1 font-mono text-[10px] text-white/35">
                  <Hash className="h-3 w-3 flex-none" strokeWidth={1.75} />
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
