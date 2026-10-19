import { useRegisterSW } from 'virtual:pwa-register/react'
import { RefreshCw, WifiOff, X } from 'lucide-react'

/** Surfaces the PWA service worker's update lifecycle to the user instead
 * of silently reloading (registerType: 'prompt' in vite.config.ts) — an
 * automatic reload could interrupt a multi-minute in-flight VLM
 * extraction, the same reasoning behind panels staying mounted instead of
 * remounting on tab switch (Phase 5). The user decides when to reload. */
export function PwaUpdateBanner() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!offlineReady && !needRefresh) return null

  const close = () => {
    setOfflineReady(false)
    setNeedRefresh(false)
  }

  return (
    <div className="animate-fade-in fixed inset-x-4 bottom-4 z-50 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:max-w-sm rounded-2xl border border-white/25 bg-black p-4 text-sm text-white shadow-xl shadow-black/50">
      {needRefresh ? (
        <div className="flex gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <RefreshCw className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white">A new version is ready.</p>
            <p className="mt-1 text-white/60">
              Reload when convenient — not during an in-progress extraction.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => updateServiceWorker(true)}
                className="rounded-lg border border-white bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white/90"
              >
                Reload now
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/40">
            <WifiOff className="h-4 w-4 text-white" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white">ClaimSense is ready to work offline.</p>
            <button
              type="button"
              onClick={close}
              className="mt-2 rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
            >
              Dismiss
            </button>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Dismiss"
            className="flex-none text-white/40 transition-colors hover:text-white"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  )
}
