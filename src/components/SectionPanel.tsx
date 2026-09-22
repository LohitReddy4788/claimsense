import type { SectionMeta } from '../types/dashboard'

interface SectionPanelProps {
  meta: SectionMeta
  children?: React.ReactNode
}

export function SectionPanel({ meta, children }: SectionPanelProps) {
  return (
    <div className="flex-1 overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{meta.label}</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{meta.description}</p>
      <div className="mt-6 rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        {children ?? 'Not wired up yet — this section is a placeholder until its agent/module phase is built.'}
      </div>
    </div>
  )
}
