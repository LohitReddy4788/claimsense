import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { SectionPanel } from './components/SectionPanel'
import { UploadReceiptsPanel } from './components/UploadReceiptsPanel'
import { PoliciesPanel } from './components/PoliciesPanel'
import { TravelRequestsPanel } from './components/TravelRequestsPanel'
import { SECTIONS, type DashboardSection } from './types/dashboard'

function App() {
  const [active, setActive] = useState<DashboardSection>('upload')
  const meta = SECTIONS.find((s) => s.id === active)!

  const content: Record<DashboardSection, React.ReactNode> = {
    upload: <UploadReceiptsPanel />,
    policies: <PoliciesPanel />,
    travel: <TravelRequestsPanel />,
    claims: undefined,
    audit: undefined,
  }

  return (
    <div className="flex h-screen w-screen bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Sidebar active={active} onSelect={setActive} />
      <SectionPanel meta={meta}>{content[active]}</SectionPanel>
    </div>
  )
}

export default App
