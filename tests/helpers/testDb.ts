import { vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

// Integration tests run against the real Postgres engine (PGlite, in
// memory) with the app's real schema — only the browser-specific worker
// wrapper around it is swapped out, via vi.mock in each test file:
//
//   vi.mock('../src/modules/storage/pg', async (orig) => ({
//     ...(await orig<object>()),
//     getPg: async () => (await import('./helpers/testDb')).currentDb(),
//   }))

let db: PGlite | null = null

export async function currentDb(): Promise<PGlite> {
  if (!db) {
    const { SCHEMA } = await vi.importActual<typeof import('../../src/modules/storage/pg')>(
      '../../src/modules/storage/pg',
    )
    db = new PGlite()
    await db.exec(SCHEMA)
  }
  return db
}

/** Empties every table between tests, so each starts from a clean store. */
export async function resetDb(): Promise<void> {
  const pg = await currentDb()
  await pg.exec(
    'TRUNCATE claims, receipts, travel_requests, policies, policy_settings, audit_logs, app_meta CASCADE',
  )
}
