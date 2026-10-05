import { PGlite } from '@electric-sql/pglite'
import { db } from './db'

// PostgreSQL (PGlite = the real Postgres engine compiled to WebAssembly)
// running inside the browser and persisted to this device's own storage, so
// the zero-network, on-device guarantee still holds. Dexie remains the
// source the app reads and writes; every write is mirrored here after its
// transaction commits, so a mirror failure can never break the app.

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_claims_receipt ON claims(receipt_id);
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
`

type Row = Record<string, unknown>
type Col = [column: string, field: string, cast?: string]

interface TableMap {
  sql: string
  pk: string
  pkField: string
  cols: Col[]
  dexie: 'receipts' | 'travelRequests' | 'policies' | 'policySettings' | 'claims' | 'auditLogs'
}

const TABLES: TableMap[] = [
  {
    sql: 'receipts', pk: 'receipt_id', pkField: 'receiptId', dexie: 'receipts',
    cols: [
      ['receipt_id', 'receiptId'], ['file_name', 'fileName'], ['file_type', 'fileType'],
      ['file_size', 'fileSize'], ['opfs_path', 'opfsPath'], ['file_hash', 'fileHash'],
      ['status', 'status'], ['uploaded_at', 'uploadedAt', 'timestamptz'],
    ],
  },
  {
    sql: 'travel_requests', pk: 'request_id', pkField: 'requestId', dexie: 'travelRequests',
    cols: [
      ['request_id', 'requestId'], ['employee_id', 'employeeId'], ['destination', 'destination'],
      ['start_date', 'startDate', 'date'], ['end_date', 'endDate', 'date'],
      ['approval_status', 'approvalStatus'],
    ],
  },
  {
    sql: 'policies', pk: 'policy_id', pkField: 'policyId', dexie: 'policies',
    cols: [
      ['policy_id', 'policyId'], ['category', 'category'], ['limit_amount', 'limitAmount', 'numeric'],
      ['notes', 'notes'],
    ],
  },
  {
    sql: 'policy_settings', pk: 'id', pkField: 'id', dexie: 'policySettings',
    cols: [['id', 'id'], ['base_currency', 'baseCurrency'], ['rates', 'rates', 'jsonb']],
  },
  {
    sql: 'claims', pk: 'claim_id', pkField: 'claimId', dexie: 'claims',
    cols: [
      ['claim_id', 'claimId'], ['receipt_id', 'receiptId'], ['file_hash', 'fileHash'],
      ['vendor', 'vendor'], ['amount', 'amount', 'numeric'], ['currency', 'currency'],
      ['receipt_date', 'date'], ['category', 'category'],
      ['travel_request_id', 'travelRequestId'], ['policy_result', 'policyResult'],
      ['policy_reason_code', 'policyReasonCode'], ['duplicate_of_claim_id', 'duplicateOfClaimId'],
      ['line_item_review_reason', 'lineItemReviewReason'], ['status', 'status'],
      ['created_at', 'createdAt', 'timestamptz'], ['approved_at', 'approvedAt', 'timestamptz'],
    ],
  },
  {
    sql: 'audit_logs', pk: 'id', pkField: 'id', dexie: 'auditLogs',
    cols: [
      ['id', 'id'], ['entity_id', 'entityId'], ['action', 'action'], ['detail', 'detail'],
      ['current_hash', 'currentHash'], ['previous_hash', 'previousHash'],
      ['timestamp', 'timestamp', 'timestamptz'],
    ],
  },
]

let pgPromise: Promise<PGlite> | null = null
let queue: Promise<void> = Promise.resolve()
let hooksInstalled = false

export function getPg(): Promise<PGlite> {
  if (!pgPromise) {
    pgPromise = (async () => {
      const pg = new PGlite('idb://claimsense-pg')
      await pg.waitReady
      await pg.exec(SCHEMA)
      return pg
    })()
    pgPromise.catch(() => {
      pgPromise = null
    })
  }
  return pgPromise
}

async function upsert(table: TableMap, record: Row) {
  const pg = await getPg()
  const cols = table.cols.map((c) => c[0])
  const placeholders = table.cols.map((c, i) => `$${i + 1}${c[2] ? `::${c[2]}` : ''}`)
  const values = table.cols.map(([, field, cast]) => {
    const v = record[field]
    if (v === undefined || v === null) return null
    return cast === 'jsonb' ? JSON.stringify(v) : v
  })
  const updates = cols.filter((c) => c !== table.pk).map((c) => `${c} = EXCLUDED.${c}`)
  await pg.query(
    `INSERT INTO ${table.sql} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (${table.pk}) DO UPDATE SET ${updates.join(', ')}`,
    values,
  )
}

function enqueue(work: () => Promise<void>) {
  queue = queue.then(work).catch((err) => {
    console.error('PostgreSQL mirror write failed (app data is unaffected):', err)
  })
}

async function mirrorOne(table: TableMap, key: unknown) {
  const record = (await db[table.dexie].get(key as never)) as unknown as Row | undefined
  if (record) await upsert(table, record)
}

async function backfill() {
  for (const table of TABLES) {
    const rows = (await db[table.dexie].toArray()) as unknown as Row[]
    for (const row of rows) await upsert(table, row)
  }
}

/** Starts the mirror: creates the Postgres schema, copies anything already in
 * Dexie across, then mirrors every later write. Safe to call more than once. */
export function startPostgresMirror() {
  if (hooksInstalled) return
  hooksInstalled = true

  for (const table of TABLES) {
    const dexieTable = db[table.dexie]
    dexieTable.hook('creating', function (_pk, _obj, trans) {
      this.onsuccess = (pk: unknown) => {
        trans.on('complete', () => enqueue(() => mirrorOne(table, pk)))
      }
    })
    dexieTable.hook('updating', (_mods, pk, _obj, trans) => {
      trans.on('complete', () => enqueue(() => mirrorOne(table, pk)))
    })
    dexieTable.hook('deleting', (pk, _obj, trans) => {
      trans.on('complete', () =>
        enqueue(async () => {
          const pg = await getPg()
          await pg.query(`DELETE FROM ${table.sql} WHERE ${table.pk} = $1`, [pk])
        }),
      )
    })
  }

  enqueue(async () => {
    await getPg()
    await backfill()
  })
}

export interface SqlResult {
  fields: string[]
  rows: Row[]
  rowCount: number
  ms: number
}

const MUTATING = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do)\b/i

/** Read-only SQL for the in-app console. The mirror is derived data, but a
 * demo console should never be able to damage it. */
export async function runReadOnlyQuery(sql: string): Promise<SqlResult> {
  const text = sql.trim().replace(/;+\s*$/, '')
  if (!/^(select|with|explain|show)\b/i.test(text) || MUTATING.test(text)) {
    throw new Error('Only read-only queries (SELECT, WITH, EXPLAIN, SHOW) are allowed here.')
  }
  await queue
  const pg = await getPg()
  const started = performance.now()
  const result = await pg.query<Row>(text)
  return {
    fields: result.fields.map((f) => f.name),
    rows: result.rows,
    rowCount: result.rows.length,
    ms: Math.round(performance.now() - started),
  }
}
