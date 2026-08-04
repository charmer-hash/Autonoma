import { eq } from 'drizzle-orm'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { users } from './schema.js'

// 在查找未命中时也会消耗这个哈希，使得"用户名不存在"和"密码错误"
// 耗时相同 —— 否则响应耗时本身就会泄露哪些用户名是存在的。
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
