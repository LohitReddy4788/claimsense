import { useState } from 'react'
import { Trash2, Loader2, CircleAlert } from 'lucide-react'
import { resetAllData } from '../agents/admin/resetAllData'
import { errorText } from './LoadingState'

const CONFIRM_WORD = 'RESET'

/** Admin only: wipes everything on this device to start a demo or a test
 * again. Typing the word first makes a stray click harmless. */
export function ResetDataCard() {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reset() {
    setBusy(true)
    setError(null)
    try {
      await resetAllData()
      try {
        sessionStorage.clear()
      } catch {
        // ignore
      }
      // Reload so no screen keeps showing what was just deleted.
      location.reload()
    } catch (err) {
      setError(`Could not reset: ${errorText(err)}`)
      setBusy(false)
    }
  }

  return (
    <section className="mt-10 rounded-2xl border border-red-400/40 p-5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-red-400/60">
          <Trash2 className="h-4 w-4 text-red-300" strokeWidth={1.75} />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">Reset all data</p>
          <p className="text-xs text-white/50">
            Deletes every receipt and its file, claim, report, trip, policy and rate, the audit log, the admin PIN and
            employee passwords from this device. It can't be undone.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="w-40 rounded-md border border-red-400/50 bg-black px-2 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-red-400/50"
          placeholder={`Type ${CONFIRM_WORD}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label={`Type ${CONFIRM_WORD} to confirm`}
        />
        <button
          type="button"
          disabled={typed.trim().toUpperCase() !== CONFIRM_WORD || busy}
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-400 bg-red-500/80 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : <Trash2 className="h-4 w-4" strokeWidth={1.75} />}
          Delete everything
        </button>
      </div>
      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-red-300">
          <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
          {error}
        </p>
      )}
    </section>
  )
}
