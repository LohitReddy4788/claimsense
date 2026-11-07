import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { SectionPanel } from './components/SectionPanel'
import { UploadReceiptsPanel } from './components/UploadReceiptsPanel'
import { PoliciesPanel } from './components/PoliciesPanel'
import { TravelRequestsPanel } from './components/TravelRequestsPanel'
import { ClaimsPanel } from './components/ClaimsPanel'
import { AuditLogsPanel } from './components/AuditLogsPanel'
import { PwaUpdateBanner } from './components/PwaUpdateBanner'
import { SqlConsolePanel } from './components/SqlConsolePanel'
import { PortalLogin } from './components/PortalLogin'
import { PORTAL_SECTIONS, type DashboardSection, type Session } from './types/dashboard'

const SESSION_KEY = 'claimsense.session'

// The signed-in portal lasts for this browser tab only. Storage can be
// unavailable (private windows, blocked site data); then it simply isn't
// remembered across a reload.
function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    if (s.portal === 'admin' || (s.portal === 'employee' && typeof s.employeeId === 'string' && s.employeeId)) return s
  } catch {
    // ignore
  }
  return null
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // ignore
  }
}

function Portal({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const sections = PORTAL_SECTIONS[session.portal]
  const [active, setActive] = useState<DashboardSection>(sections[0].id)
  const employeeId = session.portal === 'employee' ? session.employeeId : undefined

  const panelBodies: Partial<Record<DashboardSection, React.ReactNode>> =
    session.portal === 'employee'
      ? {
          upload: <UploadReceiptsPanel employeeId={session.employeeId} />,
          claims: <ClaimsPanel active={active === 'claims'} portal="employee" employeeId={employeeId} />,
          travel: <TravelRequestsPanel portal="employee" employeeId={employeeId} />,
        }
      : {
          claims: <ClaimsPanel active={active === 'claims'} portal="admin" />,
          travel: <TravelRequestsPanel portal="admin" />,
          policies: <PoliciesPanel />,
          audit: <AuditLogsPanel active={active === 'audit'} />,
          database: <SqlConsolePanel active={active === 'database'} />,
        }

  return (
    <div className="flex h-dvh w-full flex-col bg-black text-white md:flex-row">
      <Sidebar sections={sections} active={active} onSelect={setActive} session={session} onSignOut={onSignOut} />
      {/* All panels stay mounted (just hidden) rather than swapped in/out —
          switching tabs must not lose in-flight state, like a multi-minute
          on-device extraction that's still running in the background. */}
      {sections.map((section) => (
        <div key={section.id} hidden={active !== section.id} className="flex min-h-0 min-w-0 flex-1">
          <SectionPanel meta={section}>{panelBodies[section.id]}</SectionPanel>
        </div>
      ))}
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(loadSession)

  const signIn = (s: Session) => {
    saveSession(s)
    setSession(s)
  }
  const signOut = () => {
    saveSession(null)
    setSession(null)
  }

  return (
    <>
      {session ? (
        // Keyed by who is signed in, so switching portal or employee starts
        // every panel fresh instead of showing the previous person's state.
        <Portal key={session.portal === 'admin' ? 'admin' : `emp:${session.employeeId}`} session={session} onSignOut={signOut} />
      ) : (
        <PortalLogin onSignIn={signIn} />
      )}
      <PwaUpdateBanner />
    </>
  )
}

export default App
