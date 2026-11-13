import { getPg, MIGRATION_KEY, placeholder, selectList, toParam, toRecord, TABLES, type Row, type TableMap } from './pg'
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
export const updateTravelRequest = (requestId: string, patch: Partial<TravelRequestRecord>) =>
  updateFields(TABLES.travelRequests, requestId, patch)

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

/** Inserts the report and links its claims in ONE transaction, marking them
 * submitted, and only claims the employee still has open (draft or review)
 * and not yet in a report: if any of them changed
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
      `UPDATE claims SET report_id = $1, status = 'submitted'
       WHERE claim_id = ANY($2::text[]) AND status IN ('draft', 'review') AND report_id IS NULL`,
      [report.reportId, claimIds],
    )
    if (linked.affectedRows !== claimIds.length) {
      throw new Error('Some of these claims changed or were already submitted. Refresh and try again.')
    }
  })
}

// Small app settings (key/value), e.g. the admin PIN's salted hash.
export async function getMeta(key: string): Promise<string | undefined> {
  const pg = await getPg()
  const r = await pg.query<{ value: string }>('SELECT value FROM app_meta WHERE key = $1', [key])
  return r.rows[0]?.value
}
export async function putMeta(key: string, value: string): Promise<void> {
  const pg = await getPg()
  await pg.query(
    'INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  )
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

/** Deletes every record — receipts, claims, reports, trips, policies,
 * rates, the audit log, the admin PIN and employee passwords — in one
 * transaction, so a half-done reset can't leave orphans. Only the note
 * that the old pre-Postgres data was already carried over is kept, so it
 * isn't imported again. */
export async function resetAllData(): Promise<void> {
  const pg = await getPg()
  await pg.transaction(async (tx) => {
    await tx.query(
      'TRUNCATE claims, claim_reports, receipts, travel_requests, policies, policy_settings, audit_logs CASCADE',
    )
    await tx.query('DELETE FROM app_meta WHERE key <> $1', [MIGRATION_KEY])
  })
}

/** Adds or replaces one currency rate in a single statement. Found in the
 * full re-test: saving rates by read-modify-write lost one when two Adds
 * overlapped (the second wrote back a table read before the first saved).
 * Merging inside the database can't lose either. Returns the stored row. */
export async function setPolicyRate(currency: string, rate: number): Promise<PolicySettingsRecord> {
  const pg = await getPg()
  const r = await pg.query<{ id: string; base_currency: string; rates: Record<string, number> }>(
    `INSERT INTO policy_settings (id, base_currency, rates) VALUES ('default', 'USD', $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET rates = policy_settings.rates || EXCLUDED.rates
     RETURNING id, base_currency, rates`,
    [JSON.stringify({ [currency]: rate })],
  )
  const row = r.rows[0]
  return { id: 'default', baseCurrency: row.base_currency, rates: row.rates }
}

/** Sets the base currency without touching the rate table. */
export async function setBaseCurrency(baseCurrency: string): Promise<PolicySettingsRecord> {
  const pg = await getPg()
  const r = await pg.query<{ base_currency: string; rates: Record<string, number> }>(
    `INSERT INTO policy_settings (id, base_currency, rates) VALUES ('default', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET base_currency = EXCLUDED.base_currency
     RETURNING base_currency, rates`,
    [baseCurrency],
  )
  return { id: 'default', baseCurrency: r.rows[0].base_currency, rates: r.rows[0].rates }
}

/** Removes a claim the employee hasn't submitted, with its receipt record,
 * in one transaction. A claim marked as a duplicate of this one stops
 * pointing at it first (it's no longer a duplicate of anything). Throws if
 * the claim was submitted or decided meanwhile, so nothing is removed. */
export async function deleteOpenClaim(claimId: string, receiptId: string): Promise<void> {
  const pg = await getPg()
  await pg.transaction(async (tx) => {
    await tx.query('UPDATE claims SET duplicate_of_claim_id = NULL WHERE duplicate_of_claim_id = $1', [claimId])
    const removed = await tx.query(`DELETE FROM claims WHERE claim_id = $1 AND status IN ('draft', 'review')`, [claimId])
    if (removed.affectedRows !== 1) throw new Error('This claim was already submitted or decided, so it can no longer be removed.')
    await tx.query('DELETE FROM receipts WHERE receipt_id = $1 AND NOT EXISTS (SELECT 1 FROM claims WHERE receipt_id = $1)', [receiptId])
  })
}
