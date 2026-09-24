import { useRegisterSW } from 'virtual:pwa-register/react'

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
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-neutral-300 bg-white p-4 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {needRefresh ? (
        <>
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            A new version is ready.
          </p>
          <p className="mt-1 text-neutral-600 dark:text-neutral-400">
            Reload when convenient — not during an in-progress extraction.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => updateServiceWorker(true)}
              className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Reload now
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Later
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            ClaimSense is ready to work offline.
          </p>
          <button
            type="button"
            onClick={close}
            className="mt-2 rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  )
}
