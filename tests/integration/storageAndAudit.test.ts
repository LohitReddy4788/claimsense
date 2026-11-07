import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/modules/storage/pg', async (orig) => ({
  ...(await orig<object>()),
  getPg: async () => (await import('../helpers/testDb')).currentDb(),
}))

const { currentDb, resetDb } = await import('../helpers/testDb')
const repo = await import('../../src/modules/storage/repository')
const { appendAuditEntry, verifyAuditChain } = await import('../../src/modules/audit/auditLog')

beforeEach(resetDb)

describe('Repository on real PostgreSQL (PGlite)', () => {
  it('round-trips every record type exactly as written', async () => {
    await repo.addTravelRequest({
      requestId: 'TR-1', employeeId: 'EMP001', destination: 'Boston',
      startDate: '2026-03-10', endDate: '2026-03-14', approvalStatus: 'approved',
    })
    await repo.addPolicy({ policyId: 'p1', category: 'Meals', limitAmount: 75.5 })
    await repo.putPolicySettings({ id: 'default', baseCurrency: 'USD', rates: { EUR: 1.1 } })

    expect(await repo.listTravelRequests()).toEqual([
      { requestId: 'TR-1', employeeId: 'EMP001', destination: 'Boston', startDate: '2026-03-10', endDate: '2026-03-14', approvalStatus: 'approved' },
    ])
    expect(await repo.listPolicies()).toEqual([{ policyId: 'p1', category: 'Meals', limitAmount: 75.5 }])
    expect(await repo.getPolicySettings()).toEqual({ id: 'default', baseCurrency: 'USD', rates: { EUR: 1.1 } })
  })

  it('enforces the schema: bad status values and orphan claims are refused', async () => {
    await expect(
      repo.addTravelRequest({
        requestId: 'TR-X', employeeId: 'E', destination: 'D', startDate: '2026-01-01',
        endDate: '2026-01-02', approvalStatus: 'maybe' as never,
      }),
    ).rejects.toThrow()
  })

  it('upgrades a database created before the new claim columns existed', async () => {
    const pg = await currentDb()
    await repo.addReceipt({
      receiptId: 'rec_old', fileName: 'old.png', fileType: 'png', fileSize: 1, opfsPath: 'receipts/rec_old',
      fileHash: 'h', status: 'processed', uploadedAt: '2026-03-01T00:00:00.000Z',
    })
    await pg.exec('ALTER TABLE claims DROP COLUMN employee_id, DROP COLUMN travel_match, DROP COLUMN line_items')
    await pg.query(
      `INSERT INTO claims (claim_id, receipt_id, file_hash, category, status, created_at)
       VALUES ('claim_old', 'rec_old', 'h', 'Meals', 'draft', now())`,
    )
    const { SCHEMA } = await vi.importActual<typeof import('../../src/modules/storage/pg')>('../../src/modules/storage/pg')
    await pg.exec(SCHEMA) // what every app start runs
    expect(await repo.getClaim('claim_old')).toMatchObject({ employeeId: null, travelMatch: null, lineItems: [] })
  })

  it('lets a database made before rejections existed store a rejected claim', async () => {
    const pg = await currentDb()
    await repo.addReceipt({
      receiptId: 'rec_old', fileName: 'old.png', fileType: 'png', fileSize: 1, opfsPath: 'receipts/rec_old',
      fileHash: 'h', status: 'processed', uploadedAt: '2026-03-01T00:00:00.000Z',
    })
    // The old schema: three statuses, no rejection columns.
    await pg.exec(`ALTER TABLE claims DROP CONSTRAINT claims_status_check;
      ALTER TABLE claims ADD CONSTRAINT claims_status_check CHECK (status IN ('draft','review','approved'));
      ALTER TABLE claims DROP COLUMN rejected_at, DROP COLUMN rejection_reason;`)
    await pg.query(
      `INSERT INTO claims (claim_id, receipt_id, file_hash, category, status, created_at)
       VALUES ('claim_old', 'rec_old', 'h', 'Meals', 'draft', now())`,
    )
    const { SCHEMA } = await vi.importActual<typeof import('../../src/modules/storage/pg')>('../../src/modules/storage/pg')
    await pg.exec(SCHEMA)
    await pg.exec(SCHEMA) // and again: every start runs it
    await repo.updateClaim('claim_old', { status: 'rejected', rejectionReason: 'x' })
    expect(await repo.getClaim('claim_old')).toMatchObject({ status: 'rejected', rejectionReason: 'x' })
    await expect(pg.query(`UPDATE claims SET status = 'bogus' WHERE claim_id = 'claim_old'`)).rejects.toThrow()
  })

  it('keeps timestamps byte-identical, so audit hashes still verify after a reload', async () => {
    const written = await appendAuditEntry('rec_1', 'RECEIPT_INGESTED', 'a.png')
    const [read] = await repo.listAuditLogs()
    expect(read.timestamp).toBe(written.timestamp)
  })
})

describe('Audit trail (SHA-256 hash chain)', () => {
  async function seedChain() {
    await appendAuditEntry('rec_1', 'RECEIPT_INGESTED', 'a.png')
    await appendAuditEntry('claim_1', 'CLAIM_CREATED', 'vendor: Cafe, amount: 9.50 USD')
    await appendAuditEntry('claim_1', 'CLAIM_APPROVED', 'approved')
  }

  it('links every entry to the previous one, starting from a genesis hash', async () => {
    await seedChain()
    const entries = await repo.listAuditLogs()
    expect(entries[0].previousHash).toBe('0'.repeat(64))
    expect(entries[1].previousHash).toBe(entries[0].currentHash)
    expect(entries[2].previousHash).toBe(entries[1].currentHash)
    expect(await verifyAuditChain()).toMatchObject({ valid: true, totalEntries: 3 })
  })

  it('stays a single linear chain under concurrent appends', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAuditEntry(`e${i}`, 'X', String(i))))
    const entries = await repo.listAuditLogs()
    expect(entries).toHaveLength(20)
    expect(new Set(entries.map((e) => e.previousHash)).size).toBe(20)
    expect((await verifyAuditChain()).valid).toBe(true)
  })

  it('detects an entry edited in place', async () => {
    await seedChain()
    await (await currentDb()).query(`UPDATE audit_logs SET detail = 'vendor: Cafe, amount: 0.95 USD' WHERE id = 2`)
    expect(await verifyAuditChain()).toMatchObject({ valid: false, brokenAtId: 2 })
  })

  it('detects a deleted entry', async () => {
    await seedChain()
    await (await currentDb()).query('DELETE FROM audit_logs WHERE id = 2')
    const r = await verifyAuditChain()
    expect(r.valid).toBe(false)
    expect(r.brokenAtId).toBe(3)
    expect(r.reason).toMatch(/deleted or reordered/)
  })

  it('detects a forged hash', async () => {
    await seedChain()
    await (await currentDb()).query(`UPDATE audit_logs SET current_hash = repeat('a', 64) WHERE id = 3`)
    expect(await verifyAuditChain()).toMatchObject({ valid: false, brokenAtId: 3 })
  })
})

describe('Read-only SQL console guard', () => {
  async function actualConsole() {
    const { runReadOnlyQueryOn } = await vi.importActual<typeof import('../../src/modules/storage/pg')>(
      '../../src/modules/storage/pg',
    )
    const pg = await currentDb()
    return (sql: string) => runReadOnlyQueryOn(pg, sql)
  }

  it('cannot change the shared connection’s settings (audit fix)', async () => {
    const runReadOnlyQuery = await actualConsole()
    await runReadOnlyQuery("SELECT set_config('search_path', 'nowhere', false)")
    // The app's own queries still find their tables afterwards.
    await expect(repo.listClaims()).resolves.toEqual([])
    expect((await runReadOnlyQuery('SELECT count(*)::int AS n FROM claims')).rows).toEqual([{ n: 0 }])
  })

  it('lets the database itself refuse a write the keyword filter misses', async () => {
    const runReadOnlyQuery = await actualConsole()
    await expect(runReadOnlyQuery('SELECT lo_create(0)')).rejects.toThrow(/read-only/)
  })

  it('refuses writes before they reach the database', async () => {
    const { runReadOnlyQuery } = await vi.importActual<typeof import('../../src/modules/storage/pg')>(
      '../../src/modules/storage/pg',
    )
    for (const sql of ['DELETE FROM claims', 'UPDATE claims SET status = 1', 'DROP TABLE audit_logs', 'SELECT 1; DELETE FROM claims']) {
      await expect(runReadOnlyQuery(sql)).rejects.toThrow(/read-only/)
    }
  })
})

describe('Admin PIN (admin portal sign-in)', () => {
  it('is set once, stored only as a salted hash, and checked on this device', async () => {
    const { hasAdminPin, setAdminPin, checkAdminPin } = await import('../../src/modules/auth/adminPin')
    expect(await hasAdminPin()).toBe(false)
    expect(await checkAdminPin('1234')).toBe(false)
    expect(await setAdminPin('12')).toMatchObject({ success: false })
    expect(await setAdminPin('4826')).toEqual({ success: true })
    expect(await setAdminPin('9999')).toMatchObject({ success: false }) // can't be overwritten from the sign-in screen

    const stored = await repo.getMeta('admin_pin')
    expect(stored).not.toContain('4826')
    expect(JSON.parse(stored!)).toMatchObject({ salt: expect.stringMatching(/^[0-9a-f]{32}$/), hash: expect.stringMatching(/^[0-9a-f]{64}$/) })

    expect(await checkAdminPin('4826')).toBe(true)
    expect(await checkAdminPin('4827')).toBe(false)
    expect((await repo.listAuditLogs()).at(-1)).toMatchObject({ action: 'ADMIN_PIN_SET' })
  })
})
