import { PGliteWorker } from '@electric-sql/pglite/worker'

// PostgreSQL (PGlite = the real Postgres engine compiled to WebAssembly)
// running inside the browser and persisted to this device's own storage
// (IndexedDB under the name below), so the zero-network, on-device
// guarantee still holds. This is the app's system of record: every read
// and write goes through repository.ts to these tables. (Until 2026-10-19
// Dexie was the store and this was a write-behind mirror — see
// migrateFromDexie() for how existing data carries over.)

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id   TEXT PRIMARY KEY,
  file_name    TEXT NOT NULL,
  file_type    TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  opfs_path    TEXT NOT NULL,
  file_hash    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('registered','processed','rejected')),
  uploaded_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_uploaded_at ON receipts(uploaded_at);

CREATE TABLE IF NOT EXISTS travel_requests (
  request_id       TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL,
  destination      TEXT NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  approval_status  TEXT NOT NULL CHECK (approval_status IN ('approved','pending','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_travel_employee ON travel_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_travel_status ON travel_requests(approval_status);

CREATE TABLE IF NOT EXISTS policies (
  policy_id     TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  limit_amount  NUMERIC(14,2) NOT NULL,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_policies_category ON policies(category);

CREATE TABLE IF NOT EXISTS policy_settings (
  id             TEXT PRIMARY KEY CHECK (id = 'default'),
  base_currency  TEXT NOT NULL,
  rates          JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id                TEXT PRIMARY KEY,
  receipt_id              TEXT NOT NULL REFERENCES receipts(receipt_id),
  file_hash               TEXT NOT NULL,
  vendor                  TEXT,
  amount                  NUMERIC(14,2),
  currency                TEXT,
  receipt_date            TEXT,
  category                TEXT NOT NULL,
  travel_request_id       TEXT REFERENCES travel_requests(request_id),
  policy_result           TEXT CHECK (policy_result IN ('PASS','VIOLATION','REVIEW')),
  policy_reason_code      TEXT,
  duplicate_of_claim_id   TEXT REFERENCES claims(claim_id),
  line_item_review_reason TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('draft','review','approved')),
  created_at              TIMESTAMPTZ NOT NULL,
  approved_at             TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS claim_reports (
  report_id     TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL,
  claim_count   INTEGER NOT NULL CHECK (claim_count > 0),
  totals        JSONB NOT NULL,
  submitted_at  TIMESTAMPTZ NOT NULL
);

-- Added 2026-11-05 (pre-submission audit); ADD COLUMN IF NOT EXISTS so a
-- database created before then gains them on its next start.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS employee_id TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS travel_match TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS line_items JSONB NOT NULL DEFAULT '[]';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS report_id TEXT REFERENCES claim_reports(report_id);
CREATE INDEX IF NOT EXISTS idx_claims_receipt ON claims(receipt_id);
CREATE INDEX IF NOT EXISTS idx_claims_employee ON claims(employee_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id             BIGINT PRIMARY KEY,
  entity_id      TEXT NOT NULL,
  action         TEXT NOT NULL,
  detail         TEXT NOT NULL,
  current_hash   TEXT NOT NULL,
  previous_hash  TEXT NOT NULL,
  timestamp      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);

CREATE TABLE IF NOT EXISTS app_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`

export type Row = Record<string, unknown>

/** How a column round-trips between a JS record and Postgres. Anything
 * without a kind is TEXT and passes through unchanged. */
type ColKind = 'int8' | 'numeric' | 'date' | 'timestamptz' | 'jsonb'
type Col = [column: string, field: string, kind?: ColKind]

export interface TableMap {
  sql: string
  pk: string
  pkField: string
  cols: Col[]
  /** Optional fields stored as NULL but absent (undefined) on the record. */
  optional?: string[]
}

export const TABLES = {
  receipts: {
    sql: 'receipts', pk: 'receipt_id', pkField: 'receiptId',
    cols: [
      ['receipt_id', 'receiptId'], ['file_name', 'fileName'], ['file_type', 'fileType'],
      ['file_size', 'fileSize', 'int8'], ['opfs_path', 'opfsPath'], ['file_hash', 'fileHash'],
      ['status', 'status'], ['uploaded_at', 'uploadedAt', 'timestamptz'],
    ],
  },
  travelRequests: {
    sql: 'travel_requests', pk: 'request_id', pkField: 'requestId',
    cols: [
      ['request_id', 'requestId'], ['employee_id', 'employeeId'], ['destination', 'destination'],
      ['start_date', 'startDate', 'date'], ['end_date', 'endDate', 'date'],
      ['approval_status', 'approvalStatus'],
    ],
  },
  policies: {
    sql: 'policies', pk: 'policy_id', pkField: 'policyId', optional: ['notes'],
    cols: [
      ['policy_id', 'policyId'], ['category', 'category'], ['limit_amount', 'limitAmount', 'numeric'],
      ['notes', 'notes'],
    ],
  },
  policySettings: {
    sql: 'policy_settings', pk: 'id', pkField: 'id',
    cols: [['id', 'id'], ['base_currency', 'baseCurrency'], ['rates', 'rates', 'jsonb']],
  },
  claims: {
    sql: 'claims', pk: 'claim_id', pkField: 'claimId',
    cols: [
      ['claim_id', 'claimId'], ['receipt_id', 'receiptId'], ['employee_id', 'employeeId'], ['file_hash', 'fileHash'],
      ['vendor', 'vendor'], ['amount', 'amount', 'numeric'], ['currency', 'currency'],
      ['receipt_date', 'date'], ['category', 'category'],
      ['travel_request_id', 'travelRequestId'], ['travel_match', 'travelMatch'],
      ['line_items', 'lineItems', 'jsonb'], ['policy_result', 'policyResult'],
      ['policy_reason_code', 'policyReasonCode'], ['duplicate_of_claim_id', 'duplicateOfClaimId'],
      ['line_item_review_reason', 'lineItemReviewReason'], ['status', 'status'], ['report_id', 'reportId'],
      ['created_at', 'createdAt', 'timestamptz'], ['approved_at', 'approvedAt', 'timestamptz'],
    ],
  },
  claimReports: {
    sql: 'claim_reports', pk: 'report_id', pkField: 'reportId',
    cols: [
      ['report_id', 'reportId'], ['employee_id', 'employeeId'], ['claim_count', 'claimCount', 'int8'],
      ['totals', 'totals', 'jsonb'], ['submitted_at', 'submittedAt', 'timestamptz'],
    ],
  },
  auditLogs: {
    sql: 'audit_logs', pk: 'id', pkField: 'id',
    cols: [
      ['id', 'id', 'int8'], ['entity_id', 'entityId'], ['action', 'action'], ['detail', 'detail'],
      ['current_hash', 'currentHash'], ['previous_hash', 'previousHash'],
      ['timestamp', 'timestamp', 'timestamptz'],
    ],
  },
} satisfies Record<string, TableMap>

export type TableName = keyof typeof TABLES

/** SELECT list that reads every column back in exactly the shape the app
 * wrote it. Timestamps in particular come back as the same
 * millisecond-precision UTC ISO string toISOString() produced — not a Date,
 * not a server-local format — because the audit chain hashes the timestamp
 * string, and any drift would make every entry look tampered. */
export function selectList(table: TableMap): string {
  return table.cols
    .map(([col, field, kind]) => {
      const expr =
        kind === 'timestamptz'
          ? `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
          : kind === 'date'
            ? `to_char(${col}, 'YYYY-MM-DD')`
            : kind === 'numeric' || kind === 'int8'
              ? `${col}::float8`
              : col
      return `${expr} AS "${field}"`
    })
    .join(', ')
}

export function toRecord<T>(table: TableMap, row: Row): T {
  const out: Row = { ...row }
  for (const field of table.optional ?? []) {
    if (out[field] === null) delete out[field]
  }
  return out as T
}

export function toParam(kind: ColKind | undefined, value: unknown): unknown {
  if (value === undefined || value === null) return null
  return kind === 'jsonb' ? JSON.stringify(value) : value
}

export function placeholder(kind: ColKind | undefined, index: number): string {
  const cast = kind === 'int8' ? 'bigint' : kind
  return `$${index}${cast ? `::${cast}` : ''}`
}

let pgPromise: Promise<PGliteWorker> | null = null

/** The database connection, opened lazily, schema-checked, and with any
 * pre-Postgres (Dexie) data carried over before the first query runs. The
 * database itself lives in a shared, leader-elected worker (pgWorker.ts) so
 * any number of open tabs all use one instance. */
export function getPg(): Promise<PGliteWorker> {
  if (!pgPromise) {
    pgPromise = (async () => {
      const pg = new PGliteWorker(
        new Worker(new URL('../../workers/pgWorker.ts', import.meta.url), { type: 'module' }),
      )
      await pg.waitReady
      await pg.exec(SCHEMA)
      await migrateFromDexie(pg)
      return pg
    })()
    pgPromise.catch(() => {
      pgPromise = null
    })
  }
  return pgPromise
}

const MIGRATION_KEY = 'dexie_migrated_at'

async function upsertRaw(pg: PGliteWorker, table: TableMap, record: Row) {
  const cols = table.cols.map((c) => c[0])
  const placeholders = table.cols.map(([, , kind], i) => placeholder(kind, i + 1))
  const values = table.cols.map(([, field, kind]) => toParam(kind, record[field]))
  const updates = cols.filter((c) => c !== table.pk).map((c) => `${c} = EXCLUDED.${c}`)
  await pg.query(
    `INSERT INTO ${table.sql} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (${table.pk}) DO UPDATE SET ${updates.join(', ')}`,
    values,
  )
}

/** One-time carry-over of anything stored before Postgres became the system
 * of record. Upserts are idempotent, so a migration interrupted halfway
 * simply runs again next start; the flag is written only once every table
 * is done. Dexie's data is left in place (never deleted) — after this, the
 * app simply never reads or writes it again. */
async function migrateFromDexie(pg: PGliteWorker) {
  const done = await pg.query<{ value: string }>('SELECT value FROM app_meta WHERE key = $1', [MIGRATION_KEY])
  if (done.rows.length > 0) return

  const { db } = await import('./db')
  const read = async (name: TableName) => {
    try {
      return (await db.table(name).toArray()) as Row[]
    } catch {
      return [] // a device that never had the Dexie database
    }
  }

  let skipped = 0
  const copy = async (name: TableName, rows: Row[]) => {
    for (const row of rows) {
      try {
        await upsertRaw(pg, TABLES[name], row)
      } catch (err) {
        // e.g. a claim whose receipt was deleted during earlier manual
        // testing (a foreign-key violation): logged, not fatal — the row
        // is still in the old Dexie store if it is ever needed.
        skipped++
        console.warn(`Skipped migrating a ${name} row:`, row, err)
      }
    }
  }

  // Parents before children, so the foreign keys hold.
  await copy('receipts', await read('receipts'))
  await copy('travelRequests', await read('travelRequests'))
  await copy('policies', await read('policies'))
  await copy('policySettings', await read('policySettings'))
  // Claims reference each other (duplicate_of_claim_id): insert without that
  // link first, then restore it once every claim exists.
  const claims = await read('claims')
  await copy('claims', claims.map((c) => ({ ...c, lineItems: c.lineItems ?? [], duplicateOfClaimId: null })))
  for (const c of claims) {
    if (c.duplicateOfClaimId) {
      await pg
        .query('UPDATE claims SET duplicate_of_claim_id = $1 WHERE claim_id = $2', [c.duplicateOfClaimId, c.claimId])
        .catch(() => skipped++)
    }
  }
  const audit = (await read('auditLogs')).sort((a, b) => Number(a.id) - Number(b.id))
  await copy('auditLogs', audit)

  await pg.query('INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
    MIGRATION_KEY,
    new Date().toISOString(),
  ])
  if (skipped > 0) console.warn(`Dexie → PostgreSQL migration finished with ${skipped} row(s) skipped.`)
}

export interface SqlResult {
  fields: string[]
  rows: Row[]
  rowCount: number
  ms: number
}

const MUTATING = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do)\b/i

/** Read-only SQL for the in-app console. This is the live system of record,
 * so the console must never be able to change or damage it — every change
 * has to go through the app (and its audit trail). */
export async function runReadOnlyQuery(sql: string): Promise<SqlResult> {
  const text = sql.trim().replace(/;+\s*$/, '')
  if (!/^(select|with|explain|show)\b/i.test(text) || MUTATING.test(text)) {
    throw new Error('Only read-only queries (SELECT, WITH, EXPLAIN, SHOW) are allowed here.')
  }
  return runReadOnlyQueryOn(await getPg(), text)
}

/** The console's query step on a given connection — split out so tests
 * can run it against an in-memory database. */
export async function runReadOnlyQueryOn(pg: Pick<PGliteWorker, 'transaction'>, text: string): Promise<SqlResult> {
  const started = performance.now()
  // The keyword filter above is a fast, friendly first check; the real
  // guarantee is Postgres itself refusing any write inside a READ ONLY
  // transaction (e.g. a data-modifying function the regex didn't spot).
  // Always rolled back, never committed. Found in the pre-submission
  // audit: READ ONLY still allows SELECT set_config('search_path', …,
  // false), and committing kept that setting on the one connection every
  // tab shares, after which every app query failed ("relation claims does
  // not exist") until a reload. A rollback undoes any such setting too.
  const result = await pg.transaction(async (tx) => {
    await tx.exec('SET TRANSACTION READ ONLY')
    try {
      return await tx.query<Row>(text)
    } finally {
      await tx.rollback()
    }
  })
  return {
    fields: result.fields.map((f) => f.name),
    rows: result.rows,
    rowCount: result.rows.length,
    ms: Math.round(performance.now() - started),
  }
}
