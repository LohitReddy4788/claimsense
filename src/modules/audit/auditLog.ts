import { db } from '../storage/db'
import type { AuditLogRecord } from '../../types/records'

// The first entry in the chain has no real predecessor to point at — a
// fixed all-zero hash marks that explicitly, the same convention a real
// blockchain genesis block uses, rather than an empty string that could be
// confused with "hash not computed yet".
const GENESIS_HASH = '0'.repeat(64)

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashInput(previousHash: string, entityId: string, action: string, timestamp: string, detail: string): string {
  return `${previousHash}|${entityId}|${action}|${timestamp}|${detail}`
}

// Two actions that happen close together (e.g. a claim created immediately
// after its receipt is ingested) must not both read the same "current last
// entry" and each compute a hash pointing at it — that would fork the
// chain into two competing heads instead of one linear history. Routing
// every append through this single promise chain serializes them.
let appendQueue: Promise<unknown> = Promise.resolve()

/** Audit Trail module — appends one tamper-evident entry per significant
 * workflow action (receipt ingested, claim created/edited/approved). Each
 * entry's hash covers the previous entry's hash plus its own fields, so
 * altering or deleting any past entry breaks every hash computed after it.
 * This is tamper-EVIDENT, not tamper-PROOF: nothing stops someone editing
 * the raw IndexedDB directly, but doing so is provably detectable via
 * verifyAuditChain() below, which is the actual point of an audit trail
 * for an expense system. */
export function appendAuditEntry(entityId: string, action: string, detail: string): Promise<AuditLogRecord> {
  const task = appendQueue.then(async () => {
    const last = await db.auditLogs.orderBy('id').last()
    const previousHash = last?.currentHash ?? GENESIS_HASH
    const timestamp = new Date().toISOString()
    const currentHash = await sha256Hex(hashInput(previousHash, entityId, action, timestamp, detail))
    const record: AuditLogRecord = { entityId, action, detail, currentHash, previousHash, timestamp }
    const id = await db.auditLogs.add(record)
    return { ...record, id }
  })
  // Keep the queue alive even if this particular append fails, so a single
  // bad write doesn't wedge every audit entry after it.
  appendQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

export interface ChainVerification {
  valid: boolean
  totalEntries: number
  brokenAtId: number | null
  reason: string | null
}

/** Walks the whole chain in insertion order and recomputes every hash from
 * scratch, rather than trusting what's stored — this is the actual tamper
 * check. Catches three distinct kinds of tampering: (1) an entry's own
 * fields edited in place without its hash being recomputed to match, (2)
 * an entry deleted, which breaks the next entry's previousHash link, (3)
 * an entry's stored currentHash forged to something that doesn't match its
 * own content. */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const entries = await db.auditLogs.orderBy('id').toArray()
  let expectedPrevious = GENESIS_HASH

  for (const entry of entries) {
    if (entry.previousHash !== expectedPrevious) {
      return {
        valid: false,
        totalEntries: entries.length,
        brokenAtId: entry.id ?? null,
        reason: `Entry ${entry.id}'s previousHash doesn't match the prior entry's hash — an entry was likely deleted or reordered.`,
      }
    }
    const recomputed = await sha256Hex(
      hashInput(entry.previousHash, entry.entityId, entry.action, entry.timestamp, entry.detail),
    )
    if (recomputed !== entry.currentHash) {
      return {
        valid: false,
        totalEntries: entries.length,
        brokenAtId: entry.id ?? null,
        reason: `Entry ${entry.id}'s stored hash doesn't match its own content — this entry was altered after being written.`,
      }
    }
    expectedPrevious = entry.currentHash
  }

  return { valid: true, totalEntries: entries.length, brokenAtId: null, reason: null }
}
