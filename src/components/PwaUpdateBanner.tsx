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
    <div className="animate-fade-in fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl border border-neutral-200 bg-white p-4 text-sm shadow-xl shadow-neutral-900/10 dark:border-neutral-800 dark:bg-neutral-900">
      {needRefresh ? (
        <div className="flex gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/40">
            <RefreshCw className="h-4 w-4 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-neutral-900 dark:text-neutral-100">A new version is ready.</p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              Reload when convenient — not during an in-progress extraction.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => updateServiceWorker(true)}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-brand-600/25 transition-colors hover:bg-brand-700"
              >
                Reload now
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-green-50 dark:bg-green-950/40">
            <WifiOff className="h-4 w-4 text-green-600 dark:text-green-400" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              ClaimSense is ready to work offline.
            </p>
            <button
              type="button"
              onClick={close}
              className="mt-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Dismiss
            </button>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Dismiss"
            className="flex-none text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  )
}
