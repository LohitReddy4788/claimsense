import { useEffect, useState } from 'react'
import { Play, Loader2, CircleAlert, Database } from 'lucide-react'
import { getPg, runReadOnlyQuery, type SqlResult } from '../modules/storage/pg'

interface SqlConsolePanelProps {
  active: boolean
}

const PRESETS: { label: string; sql: string }[] = [
  {
    label: 'All claims',
    sql: 'SELECT claim_id, vendor, amount, currency, category, status, policy_result\nFROM claims\nORDER BY created_at DESC;',
  },
  {
    label: 'Spend by category',
    sql: "SELECT category, COUNT(*) AS claims, SUM(amount) AS total\nFROM claims\nWHERE status = 'approved'\nGROUP BY category\nORDER BY total DESC;",
  },
  {
    label: 'Claims + receipts (JOIN)',
    sql: 'SELECT c.vendor, c.amount, r.file_name, r.file_size\nFROM claims c\nJOIN receipts r ON r.receipt_id = c.receipt_id;',
  },
  {
    label: 'Audit hash chain',
    sql: 'SELECT id, action, entity_id, LEFT(previous_hash, 10) AS prev, LEFT(current_hash, 10) AS curr\nFROM audit_logs\nORDER BY id;',
  },
  {
    label: 'Tables',
    sql: "SELECT table_name, (xpath('/row/c/text()', query_to_xml('select count(*) as c from ' || table_name, false, true, '')))[1]::text AS rows\nFROM information_schema.tables\nWHERE table_schema = 'public'\nORDER BY table_name;",
  },
]

function format(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function SqlConsolePanel({ active }: SqlConsolePanelProps) {
  const [sql, setSql] = useState(PRESETS[0].sql)
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    getPg()
      .then((pg) => pg.query<{ v: string }>('SELECT version() AS v'))
      .then((r) => setVersion(r.rows[0].v.split(' on ')[0]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [active])

  async function run(text: string) {
    setRunning(true)
    setError(null)
    try {
      setResult(await runReadOnlyQuery(text))
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <div className="flex items-start gap-2.5 rounded-2xl border border-white/15 p-4">
        <Database className="mt-0.5 h-4 w-4 flex-none text-white/70" strokeWidth={1.75} />
        <div className="text-xs text-white/60">
          <p className="font-medium text-white">{version ?? 'Starting PostgreSQL…'}</p>
          <p className="mt-1">
            Real PostgreSQL running inside this browser (WebAssembly), saved on this device. This is the app's own
            database: every claim, receipt, policy, trip and audit entry is stored here. Queries run in a read-only
            transaction, so nothing here can change your data.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setSql(p.sql)
              run(p.sql)
            }}
            className="rounded-lg border border-white/30 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-white hover:bg-white/5"
          >
            {p.label}
          </button>
        ))}
      </div>

      <textarea
        id="sql-input"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        spellCheck={false}
        rows={6}
        className="mt-3 w-full rounded-xl border border-white/25 bg-black p-3 font-mono text-xs text-white focus:border-white focus:outline-none focus:ring-1 focus:ring-white/40"
      />
      <button
        type="button"
        onClick={() => run(sql)}
        disabled={running}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white bg-white px-3.5 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-50"
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <Play className="h-3.5 w-3.5" strokeWidth={1.75} />}
        Run query
      </button>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-white">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4">
          <p className="text-xs text-white/50">
            {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.ms} ms
          </p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-white/15">
            <table className="w-full min-w-max text-left text-xs">
              <thead>
                <tr className="border-b border-white/15 text-white/60">
                  {result.fields.map((f) => (
                    <th key={f} className="px-3 py-2 font-medium">
                      {f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-b border-white/10 last:border-0">
                    {result.fields.map((f) => (
                      <td key={f} className="px-3 py-2 font-mono text-white/85">
                        {format(row[f])}
                      </td>
                    ))}
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-white/40" colSpan={Math.max(1, result.fields.length)}>
                      No rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
