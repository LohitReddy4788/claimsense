import { useEffect, useState } from 'react'
import { ShieldCheck, UserRound, KeyRound, ArrowRight, Lock, Loader2, CircleAlert } from 'lucide-react'
import { checkAdminPin, hasAdminPin, setAdminPin } from '../modules/auth/adminPin'
import { checkEmployeePassword } from '../modules/auth/employeePassword'
import { errorText } from './LoadingState'
import type { Portal, Session } from '../types/dashboard'

interface PortalLoginProps {
  onSignIn: (session: Session) => void
}

const INPUT =
  'w-full rounded-lg border border-white/25 bg-black px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40'
const PRIMARY =
  'inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white bg-white px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-white/90 disabled:opacity-50'

/** Chooses the portal. Everything is checked on this device: the employee
 * portal takes an employee ID, and the admin portal a PIN whose salted
 * hash is stored in the local database (set the first time it's used). */
export function PortalLogin({ onSignIn }: PortalLoginProps) {
  const [portal, setPortal] = useState<Portal>('employee')
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [pinAgain, setPinAgain] = useState('')
  const [pinExists, setPinExists] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    hasAdminPin()
      .then(setPinExists)
      .catch((err) => setError(`Could not open the on-device database: ${errorText(err)}`))
  }, [])

  function choose(p: Portal) {
    setPortal(p)
    setError(null)
    setPin('')
    setPinAgain('')
    setPassword('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (portal === 'employee') {
      const id = employeeId.trim().toUpperCase()
      if (!/^[A-Z0-9_-]{2,20}$/.test(id)) {
        setError('Enter your employee ID, e.g. EMP001 (letters and numbers only).')
        return
      }
      setBusy(true)
      try {
        if (await checkEmployeePassword(id, password)) onSignIn({ portal: 'employee', employeeId: id })
        else setError('Wrong employee ID or password.')
      } catch (err) {
        setError(errorText(err))
      } finally {
        setBusy(false)
      }
      return
    }
    setBusy(true)
    try {
      if (!pinExists) {
        if (pin !== pinAgain) {
          setError("The two PINs don't match.")
          return
        }
        const set = await setAdminPin(pin)
        if (!set.success) {
          setError(set.reason)
          return
        }
        onSignIn({ portal: 'admin' })
        return
      }
      if (await checkAdminPin(pin)) onSignIn({ portal: 'admin' })
      else setError('Wrong PIN.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const tab = (p: Portal, label: string, Icon: typeof UserRound) => (
    <button
      type="button"
      role="tab"
      aria-selected={portal === p}
      onClick={() => choose(p)}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        portal === p ? 'bg-white text-black' : 'text-white/60 hover:text-white'
      }`}
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} />
      {label}
    </button>
  )

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-black px-4 py-10 text-white">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/70">
            <ShieldCheck className="h-6 w-6 text-white" strokeWidth={1.75} />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">ClaimSense</h1>
          <p className="mt-1 text-sm text-white/50">Expense claims, processed entirely on this device</p>
        </div>

        <div role="tablist" className="mt-8 flex gap-1 rounded-xl border border-white/20 p-1">
          {tab('employee', 'Employee', UserRound)}
          {tab('admin', 'Admin', KeyRound)}
        </div>

        <form onSubmit={submit} className="mt-4 rounded-2xl border border-white/15 p-5">
          {portal === 'employee' ? (
            <>
              <p className="text-sm font-semibold">Employee portal</p>
              <p className="mt-0.5 text-xs text-white/50">Upload receipts, request trips, and check and submit your claims.</p>
              <label className="mt-4 block text-xs text-white/50" htmlFor="login-employee">
                Employee ID
              </label>
              <input
                id="login-employee"
                autoFocus
                autoComplete="off"
                className={`mt-1 ${INPUT} uppercase`}
                placeholder="EMP001"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              />
              <label className="mt-3 block text-xs text-white/50" htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                className={`mt-1 ${INPUT}`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : (
            <>
              <p className="text-sm font-semibold">Admin portal</p>
              <p className="mt-0.5 text-xs text-white/50">
                Policies, travel and claim approvals, audit log and database.
              </p>
              {pinExists === null && !error ? (
                <p className="mt-4 flex items-center gap-2 text-xs text-white/50">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                  Opening the on-device database…
                </p>
              ) : (
                <>
                  {!pinExists && (
                    <p className="mt-3 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/60">
                      First time here: choose an admin PIN. Only a salted hash of it is stored, on this device.
                    </p>
                  )}
                  <label className="mt-4 block text-xs text-white/50" htmlFor="login-pin">
                    {pinExists ? 'Admin PIN' : 'New admin PIN (4+ characters)'}
                  </label>
                  <input
                    id="login-pin"
                    type="password"
                    autoFocus
                    autoComplete={pinExists ? 'current-password' : 'new-password'}
                    className={`mt-1 ${INPUT}`}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                  />
                  {!pinExists && (
                    <>
                      <label className="mt-3 block text-xs text-white/50" htmlFor="login-pin-again">
                        Repeat the PIN
                      </label>
                      <input
                        id="login-pin-again"
                        type="password"
                        autoComplete="new-password"
                        className={`mt-1 ${INPUT}`}
                        value={pinAgain}
                        onChange={(e) => setPinAgain(e.target.value)}
                      />
                    </>
                  )}
                </>
              )}
            </>
          )}

          {error && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-red-300">
              <CircleAlert className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              {error}
            </p>
          )}

          <button type="submit" disabled={busy || (portal === 'admin' && pinExists === null)} className={`mt-5 ${PRIMARY}`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <ArrowRight className="h-4 w-4" strokeWidth={2} />}
            {portal === 'employee' ? 'Continue' : pinExists ? 'Unlock admin portal' : 'Set PIN and continue'}
          </button>
        </form>

        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-[11px] text-white/40">
          <Lock className="h-3 w-3" strokeWidth={1.75} />
          Nothing you enter here leaves this device.
        </p>
      </div>
    </div>
  )
}
