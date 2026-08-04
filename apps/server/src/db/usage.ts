import { and, eq, gte, sql } from 'drizzle-orm'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { usageEvents } from './schema.js'

export type NewUsageEvent = {
  ownerId: string | undefined
  sessionId: string
  model: string
  promptTokens: number
  completionTokens: number
  costUsd: number
}

export async function insertUsageEvent(event: NewUsageEvent): Promise<void> {
  await withRetry(() =>
    db.insert(usageEvents).values({
      ownerId: event.ownerId ?? null,
      sessionId: event.sessionId,
      model: event.model,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      costUsd: event.costUsd,
    }),
  )
}

// 最近 24 小时内这个用户的花费总和（美元）——滚动窗口，不是自然日。
// ownerId 为 undefined 时（鉴权关闭）直接返回 0，不对匿名/本地开发
// 场景做额度控制。
export async function getDailyCostUsd(ownerId: string | undefined): Promise<number> {
  if (!ownerId) return 0
  const rows = await withRetry(() =>
    db
      .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.ownerId, ownerId), gte(usageEvents.createdAt, sql`now() - interval '24 hours'`))),
  )
  return Number(rows[0]?.total ?? 0)
}
