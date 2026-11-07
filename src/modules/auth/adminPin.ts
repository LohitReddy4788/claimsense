import * as repo from '../storage/repository'
import { appendAuditEntry } from '../audit/auditLog'

const KEY = 'admin_pin'
const MIN_LENGTH = 4

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Whether an admin PIN has been set on this device yet. */
export async function hasAdminPin(): Promise<boolean> {
  return (await repo.getMeta(KEY)) !== undefined
}

/** Sets the admin PIN the first time. Only a salted SHA-256 hash is
 * stored, in the on-device database; the PIN itself is never kept. */
export async function setAdminPin(pin: string): Promise<{ success: true } | { success: false; reason: string }> {
  if (await hasAdminPin()) return { success: false, reason: 'An admin PIN is already set.' }
  if (pin.length < MIN_LENGTH) return { success: false, reason: `Use at least ${MIN_LENGTH} characters.` }
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  await repo.putMeta(KEY, JSON.stringify({ salt, hash: await sha256Hex(salt + pin) }))
  await appendAuditEntry('admin', 'ADMIN_PIN_SET', 'admin PIN created (stored as a salted SHA-256 hash)')
  return { success: true }
}

export async function checkAdminPin(pin: string): Promise<boolean> {
  const stored = await repo.getMeta(KEY)
  if (!stored) return false
  try {
    const { salt, hash } = JSON.parse(stored) as { salt: string; hash: string }
    return (await sha256Hex(salt + pin)) === hash
  } catch {
    return false
  }
}
