import { useEffect, useRef } from 'react'

/** Keeps a panel's list current while it's on screen. It reloads when the
 * panel is opened, when the window comes back into focus, and every few
 * seconds while the panel is shown.
 *
 * Found in testing: the admin's Travel Approvals list was read only once, at
 * sign-in. A trip an employee requested afterwards (in another tab or
 * window) never showed up, so the admin couldn't approve it. The database is
 * shared by every tab; only the panel's copy of it was stale. */
export function useLiveRefresh(active: boolean, refresh: () => unknown, intervalMs = 4000) {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    if (!active) return
    const run = () => {
      if (document.visibilityState === 'visible') void latest.current()
    }
    run()
    const timer = window.setInterval(run, intervalMs)
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [active, intervalMs])
}
