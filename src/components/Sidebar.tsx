import type { LucideIcon } from 'lucide-react'
import { UploadCloud, ShieldCheck, Plane, Receipt, History, Lock } from 'lucide-react'
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
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  return (
    <nav className="flex w-64 flex-none flex-col border-r border-neutral-200/80 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-sm shadow-brand-600/30">
          <ShieldCheck className="h-5 w-5 text-white" strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            ClaimSense
          </p>
          <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
            Local-first expense claims
          </p>
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
              className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-all duration-150 ${
                isActive
                  ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/25'
                  : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-900'
              }`}
            >
              <Icon
                className={`h-[18px] w-[18px] flex-none transition-colors ${
                  isActive ? 'text-white' : 'text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300'
                }`}
                strokeWidth={2}
              />
              {section.label}
            </button>
          )
        })}
      </div>

      <div className="mx-3 mb-4 flex items-center gap-2 rounded-lg border border-dashed border-neutral-300 px-3 py-2.5 dark:border-neutral-800">
        <Lock className="h-3.5 w-3.5 flex-none text-neutral-400 dark:text-neutral-500" strokeWidth={2} />
        <p className="text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">
          Everything runs on this device. Nothing sensitive leaves it.
        </p>
      </div>
    </nav>
  )
}
