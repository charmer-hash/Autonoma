import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)
const KEY_LEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const derived = (await scrypt(password, salt, KEY_LEN)) as Buffer
  return `${salt}:${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':')
  if (!salt || !hashHex) return false
  const derived = (await scrypt(password, salt, KEY_LEN)) as Buffer
  const expected = Buffer.from(hashHex, 'hex')
  return expected.length === derived.length && timingSafeEqual(derived, expected)
}
