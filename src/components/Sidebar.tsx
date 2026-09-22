import { SECTIONS, type DashboardSection } from '../types/dashboard'

interface SidebarProps {
  active: DashboardSection
  onSelect: (section: DashboardSection) => void
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  return (
    <nav className="flex w-56 flex-none flex-col gap-1 border-r border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-4 px-2">
        <p className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">ClaimSense</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">Local-first expense claims</p>
      </div>
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => onSelect(section.id)}
          className={`rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
            active === section.id
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800'
          }`}
        >
          {section.label}
        </button>
      ))}
    </nav>
  )
}
