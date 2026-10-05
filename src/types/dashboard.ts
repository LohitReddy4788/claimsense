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

export const SECTIONS: SectionMeta[] = [
  { id: 'upload', label: 'Upload Receipts', description: 'Register receipt PDFs and images for processing.' },
  { id: 'policies', label: 'Policies', description: 'Company expense rules used by the Policy Engine.' },
  { id: 'travel', label: 'Travel Requests', description: 'Approved trips used for reconciliation.' },
  { id: 'claims', label: 'Claims', description: 'Generated claims awaiting review or exported.' },
  { id: 'audit', label: 'Audit Logs', description: 'SHA-256 hash-chained record of workflow actions.' },
  { id: 'database', label: 'Database (SQL)', description: 'PostgreSQL mirror of all claim data — run read-only SQL on it.' },
]
