import type { LucideIcon } from 'lucide-react'
import { UploadCloud, ShieldCheck, Plane, Receipt, History, Database } from 'lucide-react'
import type { SectionMeta, DashboardSection } from '../types/dashboard'

interface SectionPanelProps {
  meta: SectionMeta
  children?: React.ReactNode
}

const SECTION_ICONS: Record<DashboardSection, LucideIcon> = {
  upload: UploadCloud,
  policies: ShieldCheck,
  travel: Plane,
  claims: Receipt,
  audit: History,
  database: Database,
}

export function SectionPanel({ meta, children }: SectionPanelProps) {
  const Icon = SECTION_ICONS[meta.id]
  return (
    <div className="flex-1 overflow-y-auto bg-black">
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-8 sm:py-8 md:px-10">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-white/70">
            <Icon className="h-5 w-5 text-white" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-white">{meta.label}</h1>
            <p className="text-sm text-white/50">{meta.description}</p>
          </div>
        </div>
        <div className="mt-7 animate-fade-in">{children}</div>
      </div>
    </div>
  )
}
