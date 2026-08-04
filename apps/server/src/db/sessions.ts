import { desc, eq, isNull, sql } from 'drizzle-orm'
import type OpenAI from 'openai'
import { createInitialMessages } from '../agent/loop.js'
import { planFold, summarizeFold, type MessageRow } from '../agent/compaction.js'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { messages, sessions } from './schema.js'

export type SessionAccess = 'owned' | 'forbidden' | 'not_found'

export type SessionSummary = { id: string; updatedAt: Date; preview: string | null }

export async function listSessions(ownerId: string | undefined, limit = 50): Promise<SessionSummary[]> {
  // 这里显式使用带表名限定的 `sessions.id`，而不是直接插值 drizzle 的
  // column 对象 —— 在这里插值会渲染出不带表限定的列名，在这个相关子查询中
  // 会被解析成 messages.id（bigint）而不是外层的 sessions.id（text），
  // 从而报错 "operator does not exist: text = bigint"。
  const previewExpr = sql<string | null>`(
    select msg.message->>'content' from messages msg
    where msg.session_id = sessions.id and msg.message->>'role' = 'user'
    order by msg.id asc limit 1
  )`
  return withRetry(() =>
    db
      .select({ id: sessions.id, updatedAt: sessions.updatedAt, preview: previewExpr })
      .from(sessions)
      .where(ownerId ? eq(sessions.ownerId, ownerId) : isNull(sessions.ownerId))
      .orderBy(desc(sessions.updatedAt))
      .limit(limit),
  )
}

// 调用方必须在用客户端提供的 sessionId 调用 loadSessionMessages 之前
// 先检查这个函数的返回值 —— 这个函数本身不会重复检查，
// 它信任调用方已经确认过结果是 'owned'/'not_found'。
export async function resolveSessionAccess(
  sessionId: string,
  ownerId: string | undefined,
): Promise<SessionAccess> {
  const rows = await withRetry(() =>
    db.select({ ownerId: sessions.ownerId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1),
  )
  if (rows.length === 0) return 'not_found'
  const storedOwner = rows[0].ownerId
  if (!storedOwner || !ownerId || storedOwner === ownerId) return 'owned'
  return 'forbidden'
}

// 容忍会话行尚不存在的情况（全新的 sessionId，
// 在 loadSessionMessagesForAgent 首次写入之前不会有任何持久化数据）——
// 返回 null 而不是抛错，效果等同于"没有可重连的沙箱"。
export async function getSandboxId(sessionId: string): Promise<string | null> {
  const rows = await withRetry(() =>
    db.select({ sandboxId: sessions.sandboxId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1),
  )
  return rows[0]?.sandboxId ?? null
}

// 调用方只能在确认会话行已经存在时才调用这个函数（例如
// 在 loadSessionMessagesForAgent 之后）—— 这只是一次普通的 UPDATE，
// 不是 upsert，否则会在什么都没匹配到的情况下悄悄地影响零行。
export async function setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
  await withRetry(() => db.update(sessions).set({ sandboxId }).where(eq(sessions.id, sessionId)))
}

// 被 loadSessionMessages 和 loadSessionMessagesForAgent 共用 ——
// 查询一个会话的所有行（包括其 id，压缩记账时需要用到），
// 在首次访问时用系统提示词为全新会话做初始化。
async function loadMessageRows(sessionId: string, ownerId: string | undefined): Promise<MessageRow[]> {
  const rows = await withRetry(() =>
    db
      .select({ id: messages.id, message: messages.message })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.id),
  )

  if (rows.length > 0) return rows

  // 未见过的 sessionId —— 创建会话行，并用系统提示词进行初始化。
  const initial = createInitialMessages()
  await withRetry(() => db.insert(sessions).values({ id: sessionId, ownerId }).onConflictDoNothing())
  const [inserted] = await withRetry(() =>
    db
      .insert(messages)
      .values({ sessionId, message: initial[0] })
      .returning({ id: messages.id, message: messages.message }),
  )
  return [inserted]
}

// 完整、未压缩的对话历史 —— 供 GET /api/sessions/:id 使用，
// 这样浏览一个旧会话时总能看到真实的原始对话轮次，
// 而不会用摘要来代替被折叠掉的消息。压缩（参见
// loadSessionMessagesForAgent）只改变*发送给模型*的内容；
// 它从不删除行，所以这里始终反映实际发生过的一切。
export async function loadSessionMessages(
  sessionId: string,
  ownerId: string | undefined,
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const rows = await loadMessageRows(sessionId, ownerId)
  return rows.map((row) => row.message)
}

// 一轮对话中实际发送给 LLM 的历史 —— 底层数据与
// loadSessionMessages 相同，但一旦未折叠的尾部超过某个大小阈值，
// 较旧的消息会被折叠进滚动摘要中（参见
// agent/compaction.ts）。仅供 POST /api/agent/run 使用。
export async function loadSessionMessagesForAgent(
  sessionId: string,
  ownerId: string | undefined,
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const rows = await loadMessageRows(sessionId, ownerId)
  const systemRow = rows[0]

  const [sessionRow] = await withRetry(() =>
    db
      .select({ summary: sessions.summary, summarizedThroughId: sessions.summarizedThroughId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1),
  )

  const cutoff = sessionRow?.summarizedThroughId ?? systemRow.id
  let tailRows = rows.filter((r) => r.id > cutoff)
  let summary = sessionRow?.summary ?? null

  const plan = planFold(tailRows)
  if (plan) {
    try {
      summary = await summarizeFold(
        summary,
        plan.toFold.map((r) => r.message),
      )
      await withRetry(() =>
        db
          .update(sessions)
          .set({ summary, summarizedThroughId: plan.cutThroughId })
          .where(eq(sessions.id, sessionId)),
      )
      tailRows = plan.keep
    } catch (err) {
      // 尽力而为：压缩失败不能导致这一轮对话中断。
      // 这次退回到发送完整的未折叠尾部；
      // 我们会在之后的调用中重试折叠。
      console.error('history compaction failed, sending full tail:', err)
    }
  }

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [systemRow.message]
  if (summary) {
    result.push({
      role: 'system',
      content:
        '以下是本会话更早部分对话的摘要（原始记录仍完整保存在数据库中，这里折叠只是为了控制发给模型的' +
        `上下文长度）：\n\n${summary}`,
    })
  }
  result.push(...tailRows.map((r) => r.message))
  return result
}

export async function appendMessages(
  sessionId: string,
  newMessages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<void> {
  if (newMessages.length === 0) return
  await withRetry(() =>
    db.insert(messages).values(newMessages.map((message) => ({ sessionId, message }))),
  )
  await withRetry(() => db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, sessionId)))
}
