import * as repo from '../storage/repository'
import { appendAuditEntry } from '../audit/auditLog'

/** Every employee's starting password. On an employee's first sign-in it
 * is checked against this, then stored for them as a salted SHA-256 hash
 * in the on-device database like the admin PIN, and from then on only that
 * stored hash is used. */
export const DEFAULT_EMPLOYEE_PASSWORD = '1234'

const keyFor = (employeeId: string) => `employee_password:${employeeId.trim().toUpperCase()}`

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hashRecord(password: string): Promise<string> {
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return JSON.stringify({ salt, hash: await sha256Hex(salt + password) })
}

/** Checks an employee's password on this device. */
export async function checkEmployeePassword(employeeId: string, password: string): Promise<boolean> {
  const id = employeeId.trim().toUpperCase()
  if (!id) return false
  const stored = await repo.getMeta(keyFor(id))
  if (!stored) {
    if (password !== DEFAULT_EMPLOYEE_PASSWORD) return false
    await repo.putMeta(keyFor(id), await hashRecord(password))
    await appendAuditEntry(id, 'EMPLOYEE_ENROLLED', 'first sign-in; password stored as a salted SHA-256 hash')
    return true
  }
  try {
    const { salt, hash } = JSON.parse(stored) as { salt: string; hash: string }
    return (await sha256Hex(salt + password)) === hash
  } catch {
    return false
  }
}
