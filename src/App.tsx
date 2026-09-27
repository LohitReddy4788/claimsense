import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { SectionPanel } from './components/SectionPanel'
import { UploadReceiptsPanel } from './components/UploadReceiptsPanel'
import { PoliciesPanel } from './components/PoliciesPanel'
import { TravelRequestsPanel } from './components/TravelRequestsPanel'
import { ClaimsPanel } from './components/ClaimsPanel'
import { AuditLogsPanel } from './components/AuditLogsPanel'
import { PwaUpdateBanner } from './components/PwaUpdateBanner'
import { SECTIONS, type DashboardSection } from './types/dashboard'

function App() {
  const [active, setActive] = useState<DashboardSection>('upload')

  const panelBodies: Partial<Record<DashboardSection, React.ReactNode>> = {
    upload: <UploadReceiptsPanel />,
    policies: <PoliciesPanel />,
    travel: <TravelRequestsPanel />,
    claims: <ClaimsPanel active={active === 'claims'} />,
    audit: <AuditLogsPanel active={active === 'audit'} />,
  }

  return (
    <div className="flex h-screen w-screen bg-black text-white">
      <Sidebar active={active} onSelect={setActive} />
      {/* All panels stay mounted (just hidden) rather than swapped in/out —
          switching tabs must not lose in-flight state, like a multi-minute
          on-device extraction that's still running in the background. */}
      {SECTIONS.map((section) => (
        <div key={section.id} hidden={active !== section.id} className="flex flex-1 min-w-0">
          <SectionPanel meta={section}>{panelBodies[section.id]}</SectionPanel>
        </div>
      ))}
      <PwaUpdateBanner />
    </div>
  )
}

export default App
