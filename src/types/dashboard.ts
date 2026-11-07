export type DashboardSection =
  | 'upload'
  | 'policies'
  | 'travel'
  | 'claims'
  | 'audit'
  | 'database'

export interface SectionMeta {
  id: DashboardSection
  label: string
  description: string
}

export type Portal = 'employee' | 'admin'

/** Who is using the app on this device right now. Kept in sessionStorage,
 * so it ends when the browser tab closes. */
export type Session = { portal: 'employee'; employeeId: string } | { portal: 'admin' }

/** The employee portal is only what an employee does: upload receipts,
 * request trips, and check and submit their claims. Everything else
 * (policies, approvals, audit, the database) is the admin's. */
export const PORTAL_SECTIONS: Record<Portal, SectionMeta[]> = {
  employee: [
    { id: 'upload', label: 'Upload Receipts', description: 'Add your receipts; they are read on this device.' },
    { id: 'claims', label: 'My Claims', description: 'Check what was read from your receipts, correct it, and submit.' },
    { id: 'travel', label: 'My Travel Requests', description: 'Request a trip; your admin approves it.' },
  ],
  admin: [
    { id: 'claims', label: 'Claim Approvals', description: 'Approve or reject what employees submitted.' },
    { id: 'travel', label: 'Travel Approvals', description: 'Approve or reject trip requests.' },
    { id: 'policies', label: 'Policies', description: 'Company expense rules used by the Policy Engine.' },
    { id: 'audit', label: 'Audit Logs', description: 'SHA-256 hash-chained record of workflow actions.' },
    { id: 'database', label: 'Database (SQL)', description: 'The PostgreSQL database behind the app — run read-only SQL on it.' },
  ],
}

/** Every section, for code that doesn't care about the portal. */
export const SECTIONS: SectionMeta[] = [...PORTAL_SECTIONS.admin, ...PORTAL_SECTIONS.employee].filter(
  (s, i, all) => all.findIndex((t) => t.id === s.id) === i,
)
