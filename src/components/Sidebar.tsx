import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { UploadCloud, ShieldCheck, Plane, Receipt, History, Lock, Database, Menu, X } from 'lucide-react'
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

function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl border border-white/70">
        <ShieldCheck className="h-5 w-5 text-white" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-white">ClaimSense</p>
        <p className="truncate text-[11px] text-white/50">Local-first expense claims</p>
      </div>
    </div>
  )
}

function NavItems({ active, onSelect }: SidebarProps) {
  return (
    <div className="flex-1 space-y-0.5 overflow-y-auto px-3 py-1">
      {SECTIONS.map((section) => {
        const Icon = SECTION_ICONS[section.id]
        const isActive = active === section.id
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150 md:py-2 ${
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
  )
}

function PrivacyNote() {
  return (
    <div className="mx-3 mb-4 flex items-center gap-2 rounded-lg border border-dashed border-white/25 px-3 py-2.5">
      <Lock className="h-3.5 w-3.5 flex-none text-white/50" strokeWidth={1.75} />
      <p className="text-[11px] leading-tight text-white/50">
        Everything runs on this device. Nothing sensitive leaves it.
      </p>
    </div>
  )
}

/** Fixed sidebar from the `md` breakpoint up; below it, a compact top bar
 * whose menu button opens the same navigation as a slide-in drawer, so
 * the content gets the full width of a phone screen. */
export function Sidebar({ active, onSelect }: SidebarProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const activeLabel = SECTIONS.find((s) => s.id === active)?.label

  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  const selectAndClose = (section: DashboardSection) => {
    onSelect(section)
    setDrawerOpen(false)
  }

  return (
    <>
      {/* Phone / narrow-window top bar */}
      <header className="flex flex-none items-center justify-between gap-3 border-b border-white/15 bg-black px-4 py-3 md:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          className="flex flex-none items-center gap-2 rounded-lg border border-white/30 px-3 py-2 text-sm font-medium text-white transition-colors hover:border-white"
        >
          <span className="max-w-[9rem] truncate">{activeLabel}</span>
          <Menu className="h-4 w-4 flex-none" strokeWidth={1.75} />
        </button>
      </header>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/70" onClick={() => setDrawerOpen(false)} />
          <nav className="animate-fade-in absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/20 bg-black">
            <div className="flex items-center justify-between gap-2 px-5 py-4">
              <Brand />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
                className="flex-none rounded-lg p-1.5 text-white/60 transition-colors hover:text-white"
              >
                <X className="h-5 w-5" strokeWidth={1.75} />
              </button>
            </div>
            <NavItems active={active} onSelect={selectAndClose} />
            <PrivacyNote />
          </nav>
        </div>
      )}

      {/* Desktop sidebar */}
      <nav className="hidden w-64 flex-none flex-col border-r border-white/15 bg-black md:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <NavItems active={active} onSelect={onSelect} />
        <PrivacyNote />
      </nav>
    </>
  )
}
