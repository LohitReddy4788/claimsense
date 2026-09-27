import type { LucideIcon } from 'lucide-react'
import { UploadCloud, ShieldCheck, Plane, Receipt, History } from 'lucide-react'
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
}

export function SectionPanel({ meta, children }: SectionPanelProps) {
  const Icon = SECTION_ICONS[meta.id]
  return (
    <div className="flex-1 overflow-y-auto bg-white dark:bg-neutral-900">
      <div className="mx-auto max-w-5xl px-8 py-8 sm:px-10">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-950/40">
            <Icon className="h-5 w-5 text-brand-600 dark:text-brand-400" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              {meta.label}
            </h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{meta.description}</p>
          </div>
        </div>
        <div className="mt-7 animate-fade-in">{children}</div>
      </div>
    </div>
  )
}
