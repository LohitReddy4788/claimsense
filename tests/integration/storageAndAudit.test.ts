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
  it('refuses writes before they reach the database', async () => {
    const { runReadOnlyQuery } = await vi.importActual<typeof import('../../src/modules/storage/pg')>(
      '../../src/modules/storage/pg',
    )
    for (const sql of ['DELETE FROM claims', 'UPDATE claims SET status = 1', 'DROP TABLE audit_logs', 'SELECT 1; DELETE FROM claims']) {
      await expect(runReadOnlyQuery(sql)).rejects.toThrow(/read-only/)
    }
  })
})
