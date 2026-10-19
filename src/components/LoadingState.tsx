import { CircleAlert, Loader2 } from 'lucide-react'

/** Shown in place of a list until its first database read finishes. The
 * on-device PostgreSQL engine takes a moment to start (longer on the first
 * launch after an update), and an empty state like "No claims yet" during
 * that window would wrongly tell someone their data is gone. */
export function LoadingState({ error }: { error?: string | null }) {
  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-2xl border border-white/15 py-12 text-center">
      {error ? (
        <>
          <CircleAlert className="h-7 w-7 text-white" strokeWidth={1.5} />
          <p className="px-4 text-sm text-white">Couldn't read the on-device database.</p>
          <p className="px-4 text-xs text-white/50">{error}</p>
        </>
      ) : (
        <>
          <Loader2 className="h-7 w-7 animate-spin text-white/40" strokeWidth={1.5} />
          <p className="text-sm text-white/50">Loading from the on-device database…</p>
        </>
      )}
    </div>
  )
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
