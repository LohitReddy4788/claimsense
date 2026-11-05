import { getPg, placeholder, selectList, toParam, toRecord, TABLES, type Row, type TableMap } from './pg'
import type {
  AuditLogRecord,
  ClaimReportRecord,
  ClaimRecord,
  PolicyRecord,
  PolicySettingsRecord,
  ReceiptRecord,
  TravelRequestRecord,
} from '../../types/records'

// The only module that talks to the database. Every agent and panel goes
// through these functions, so the SQL lives in one place and the rest of
// the app keeps working with the same plain record types as before.

async function selectAll<T>(table: TableMap, tail = ''): Promise<T[]> {
  const pg = await getPg()
  const result = await pg.query<Row>(`SELECT ${selectList(table)} FROM ${table.sql} ${tail}`)
  return result.rows.map((r) => toRecord<T>(table, r))
}

async function selectOne<T>(table: TableMap, key: unknown): Promise<T | undefined> {
  const pg = await getPg()
  const result = await pg.query<Row>(
    `SELECT ${selectList(table)} FROM ${table.sql} WHERE ${table.pk} = $1`,
    [key],
  )
  return result.rows[0] ? toRecord<T>(table, result.rows[0]) : undefined
}

/** Plain INSERT — a duplicate primary key is an error, as with Dexie's add(). */
async function insert(table: TableMap, record: object) {
  const pg = await getPg()
  const values = record as Row
  await pg.query(
    `INSERT INTO ${table.sql} (${table.cols.map((c) => c[0]).join(', ')})
     VALUES (${table.cols.map(([, , kind], i) => placeholder(kind, i + 1)).join(', ')})`,
    table.cols.map(([, field, kind]) => toParam(kind, values[field])),
  )
}

async function upsert(table: TableMap, record: object) {
  const pg = await getPg()
  const values = record as Row
  const cols = table.cols.map((c) => c[0])
  await pg.query(
    `INSERT INTO ${table.sql} (${cols.join(', ')})
     VALUES (${table.cols.map(([, , kind], i) => placeholder(kind, i + 1)).join(', ')})
     ON CONFLICT (${table.pk}) DO UPDATE SET ${cols
       .filter((c) => c !== table.pk)
       .map((c) => `${c} = EXCLUDED.${c}`)
       .join(', ')}`,
    table.cols.map(([, field, kind]) => toParam(kind, values[field])),
  )
}

/** Updates only the fields present in `patch`, as Dexie's update() did. */
async function updateFields(table: TableMap, key: unknown, patch: object) {
  const entries = Object.entries(patch).filter(([field]) => field !== table.pkField)
  if (entries.length === 0) return
  const sets = entries.map(([field], i) => {
    const col = table.cols.find((c) => c[1] === field)
    if (!col) throw new Error(`Unknown field "${field}" for table ${table.sql}`)
    return `${col[0]} = ${placeholder(col[2], i + 1)}`
  })
  const params = entries.map(([field, value]) => toParam(table.cols.find((c) => c[1] === field)?.[2], value))
  const pg = await getPg()
  await pg.query(
    `UPDATE ${table.sql} SET ${sets.join(', ')} WHERE ${table.pk} = $${entries.length + 1}`,
    [...params, key],
  )
}

// Receipts
export const listReceipts = () => selectAll<ReceiptRecord>(TABLES.receipts, 'ORDER BY uploaded_at DESC')
export const addReceipt = (r: ReceiptRecord) => insert(TABLES.receipts, r)
export const updateReceiptStatus = (receiptId: string, status: ReceiptRecord['status']) =>
  updateFields(TABLES.receipts, receiptId, { status })

// Travel requests
export const listTravelRequests = () => selectAll<TravelRequestRecord>(TABLES.travelRequests, 'ORDER BY start_date')
export const addTravelRequest = (r: TravelRequestRecord) => insert(TABLES.travelRequests, r)

// Policies
export const listPolicies = () => selectAll<PolicyRecord>(TABLES.policies, 'ORDER BY category')
export const addPolicy = (p: PolicyRecord) => insert(TABLES.policies, p)
export const getPolicySettings = () => selectOne<PolicySettingsRecord>(TABLES.policySettings, 'default')
export const putPolicySettings = (s: PolicySettingsRecord) => upsert(TABLES.policySettings, s)

// Claims
export const listClaims = () => selectAll<ClaimRecord>(TABLES.claims, 'ORDER BY created_at DESC')
export const getClaim = (claimId: string) => selectOne<ClaimRecord>(TABLES.claims, claimId)
export const addClaim = (c: ClaimRecord) => insert(TABLES.claims, c)
export const updateClaim = (claimId: string, patch: Partial<ClaimRecord>) =>
  updateFields(TABLES.claims, claimId, patch)

// Expense reports
export const listReports = () =>
  selectAll<ClaimReportRecord>(TABLES.claimReports, 'ORDER BY submitted_at DESC')

/** Inserts the report and links its claims in ONE transaction, and only
 * claims still approved and not yet in a report: if any of them changed
 * since the caller read them (another tab submitted it first), nothing is
 * written and this throws, so a claim can never land in two reports. */
export async function submitReport(report: ClaimReportRecord, claimIds: string[]): Promise<void> {
  const pg = await getPg()
  const table = TABLES.claimReports
  await pg.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO ${table.sql} (${table.cols.map((c) => c[0]).join(', ')})
       VALUES (${table.cols.map(([, , kind], i) => placeholder(kind, i + 1)).join(', ')})`,
      table.cols.map(([, field, kind]) => toParam(kind, (report as unknown as Row)[field])),
    )
    const linked = await tx.query(
      `UPDATE claims SET report_id = $1
       WHERE claim_id = ANY($2::text[]) AND status = 'approved' AND report_id IS NULL`,
      [report.reportId, claimIds],
    )
    if (linked.affectedRows !== claimIds.length) {
      throw new Error('Some of these claims changed or were already submitted. Refresh and try again.')
    }
  })
}

// Audit log
export const listAuditLogs = (order: 'asc' | 'desc' = 'asc') =>
  selectAll<AuditLogRecord>(TABLES.auditLogs, `ORDER BY id ${order === 'asc' ? 'ASC' : 'DESC'}`)

/** Reads the chain's current head and inserts the next entry in ONE
 * transaction. Transactions run one at a time on the shared database, so
 * even two tabs appending at the same instant can't both link to the same
 * head and fork the chain. `build` gets the head (or undefined for the very
 * first entry) and returns the new entry with its hash computed. */
export async function appendAuditLog(
  build: (head: AuditLogRecord | undefined) => Promise<Omit<AuditLogRecord, 'id'>>,
): Promise<AuditLogRecord> {
  const pg = await getPg()
  const table = TABLES.auditLogs
  return pg.transaction(async (tx) => {
    const headRows = await tx.query<Row>(`SELECT ${selectList(table)} FROM audit_logs ORDER BY id DESC LIMIT 1`)
    const head = headRows.rows[0] ? toRecord<AuditLogRecord>(table, headRows.rows[0]) : undefined
    const entry = await build(head)
    const id = (head?.id ?? 0) + 1
    await tx.query(
      `INSERT INTO audit_logs (id, entity_id, action, detail, current_hash, previous_hash, timestamp)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [id, entry.entityId, entry.action, entry.detail, entry.currentHash, entry.previousHash, entry.timestamp],
    )
    return { ...entry, id }
  })
}
