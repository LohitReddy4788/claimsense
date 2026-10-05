import type { LucideIcon } from 'lucide-react'
import { UploadCloud, ShieldCheck, Plane, Receipt, History, Lock, Database } from 'lucide-react'
import { SECTIONS, type DashboardSection } from '../types/dashboard'

interface SidebarProps {
  active: DashboardSection
  onSelect: (section: DashboardSection) => void
}

const SECTION_ICONS: Record<DashboardSection, LucideIcon> = {
  upload: UploadCloud,
  policies: ShieldCheck,
  travel: Plane,
  claims: Receipt,
  audit: History,
  database: Database,
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  return (
    <nav className="flex w-64 flex-none flex-col border-r border-white/15 bg-black">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl border border-white/70">
          <ShieldCheck className="h-5 w-5 text-white" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-white">ClaimSense</p>
          <p className="truncate text-[11px] text-white/50">Local-first expense claims</p>
        </div>
      </div>

      <div className="flex-1 space-y-0.5 px-3 py-1">
        {SECTIONS.map((section) => {
          const Icon = SECTION_ICONS[section.id]
          const isActive = active === section.id
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors duration-150 ${
                isActive
                  ? 'border-white bg-white text-black'
                  : 'border-transparent text-white/70 hover:border-white/30 hover:text-white'
              }`}
            >
              <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.75} />
              {section.label}
            </button>
          )
        })}
      </div>

      <div className="mx-3 mb-4 flex items-center gap-2 rounded-lg border border-dashed border-white/25 px-3 py-2.5">
        <Lock className="h-3.5 w-3.5 flex-none text-white/50" strokeWidth={1.75} />
        <p className="text-[11px] leading-tight text-white/50">
          Everything runs on this device. Nothing sensitive leaves it.
        </p>
      </div>
    </nav>
  )
}
