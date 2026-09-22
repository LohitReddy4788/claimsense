import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { SectionPanel } from './components/SectionPanel'
import { UploadReceiptsPanel } from './components/UploadReceiptsPanel'
import { SECTIONS, type DashboardSection } from './types/dashboard'

function App() {
  const [active, setActive] = useState<DashboardSection>('upload')
  const meta = SECTIONS.find((s) => s.id === active)!

  return (
    <div className="flex h-screen w-screen bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Sidebar active={active} onSelect={setActive} />
      {active === 'upload' ? (
        <SectionPanel meta={meta}>
          <UploadReceiptsPanel />
        </SectionPanel>
      ) : (
        <SectionPanel meta={meta} />
      )}
    </div>
  )
}

export default App
