import { eq } from 'drizzle-orm'
import type { AgentSettings } from '@autonoma/shared'
import { hashPassword, verifyPassword } from '../lib/password.js'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { users } from './schema.js'

// 在查找未命中时也会消耗这个哈希，使得"用户名不存在"和"密码错误"
// 耗时相同 —— 否则响应耗时本身就会泄露哪些用户名是存在的。
const dummyHash = hashPassword('dummy-password-for-timing')

const usernameCache = new Map<string, { username: string; expiresAt: number }>()
function cacheUsername(id: string, username: string): void {
  if (usernameCache.size >= 256) usernameCache.delete(usernameCache.keys().next().value!)
  usernameCache.set(id, { username, expiresAt: Date.now() + 5 * 60_000 })
}

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
  if (ok) cacheUsername(rows[0].id, username)
  return ok ? rows[0].id : undefined
}

export async function getUsernameById(id: string): Promise<string | undefined> {
  const cached = usernameCache.get(id)
  if (cached && cached.expiresAt > Date.now()) return cached.username
  usernameCache.delete(id)
  const rows = await withRetry(() =>
    db.select({ username: users.username }).from(users).where(eq(users.id, id)).limit(1),
  )
  if (rows[0]) cacheUsername(id, rows[0].username)
  return rows[0]?.username
}

// 同一进程内按账号复用设置，并合并同时到达的首次读取。
// 保存成功后替换缓存；读取失败不缓存，以便下一次请求重试。
const settingsCache = new Map<string, Promise<AgentSettings>>()
function cacheSettings(id: string, settings: Promise<AgentSettings>): void {
  settingsCache.delete(id)
  if (settingsCache.size >= 256) settingsCache.delete(settingsCache.keys().next().value!)
  settingsCache.set(id, settings)
}

export async function getAgentSettings(id: string): Promise<AgentSettings> {
  let pending = settingsCache.get(id)
  if (!pending) {
    pending = readAgentSettings(id)
    cacheSettings(id, pending)
  } else {
    cacheSettings(id, pending)
  }
  try {
    return { ...await pending }
  } catch (err) {
    if (settingsCache.get(id) === pending) settingsCache.delete(id)
    throw err
  }
}

async function readAgentSettings(id: string): Promise<AgentSettings> {
  const rows = await withRetry(() =>
    db
      .select({
        customInstructions: users.customInstructions,
        approvalMode: users.approvalMode,
        maxTurns: users.maxTurns,
        codeExecEnabled: users.codeExecEnabled,
        webSearchEnabled: users.webSearchEnabled,
        visionEnabled: users.visionEnabled,
        modelChoice: users.modelChoice,
        conciseReplies: users.conciseReplies,
        sandboxIdleMinutes: users.sandboxIdleMinutes,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1),
  )
  const row = rows[0]
  return {
    customInstructions: row?.customInstructions ?? '',
    approvalMode: row?.approvalMode === 'confirm' ? 'confirm' : 'auto',
    maxTurns: row?.maxTurns ?? 30,
    codeExecEnabled: row?.codeExecEnabled ?? true,
    webSearchEnabled: row?.webSearchEnabled ?? true,
    visionEnabled: row?.visionEnabled ?? true,
    modelChoice: row?.modelChoice === 'grok' ? 'grok' : 'default',
    conciseReplies: row?.conciseReplies ?? false,
    sandboxIdleMinutes: row?.sandboxIdleMinutes ?? 10,
  }
}

export async function updateAgentSettings(id: string, settings: AgentSettings): Promise<void> {
  await withRetry(() =>
    db
      .update(users)
      .set({
        customInstructions: settings.customInstructions,
        approvalMode: settings.approvalMode,
        maxTurns: settings.maxTurns,
        codeExecEnabled: settings.codeExecEnabled,
        webSearchEnabled: settings.webSearchEnabled,
        visionEnabled: settings.visionEnabled,
        modelChoice: settings.modelChoice,
        conciseReplies: settings.conciseReplies,
        sandboxIdleMinutes: settings.sandboxIdleMinutes,
      })
      .where(eq(users.id, id)),
  )
  cacheSettings(id, Promise.resolve({ ...settings }))
}
