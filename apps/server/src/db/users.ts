import { eq } from 'drizzle-orm'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { users } from './schema.js'

// Burned on a lookup miss so "unknown username" and "wrong password" take
// the same amount of time — otherwise the response latency itself leaks
// which usernames exist.
const dummyHash = hashPassword('dummy-password-for-timing')

export async function findUserIdByCredentials(
  username: string,
  password: string,
): Promise<string | undefined> {
  const rows = await withRetry(() =>
    db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.username, username))
      .limit(1),
  )

  if (rows.length === 0) {
    await verifyPassword(password, await dummyHash)
    return undefined
  }

  const ok = await verifyPassword(password, rows[0].passwordHash)
  return ok ? rows[0].id : undefined
}
