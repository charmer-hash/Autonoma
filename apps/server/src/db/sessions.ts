import { and, eq, gt, sql } from 'drizzle-orm'
import type OpenAI from 'openai'
import { createInitialMessages } from '../agent/loop.js'
import { planFold, summarizeFold, type MessageRow } from '../agent/compaction.js'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { messages, sessions } from './schema.js'

export type SessionAccess = 'owned' | 'forbidden' | 'not_found'

export type SessionSummary = { id: string; updatedAt: Date; preview: string | null; name: string | null }

export async function listSessions(
  ownerId: string | undefined,
  opts: { limit?: number; offset?: number; search?: string } = {},
): Promise<{ sessions: SessionSummary[]; hasMore: boolean }> {
  const limit = opts.limit ?? 50
  const offset = opts.offset ?? 0
  const trimmedSearch = opts.search?.trim()

  // preview（第一条用户消息的文本）是靠相关子查询算出来的、不是
  // sessions 表上真实存在的列。
  const ownerFilter = ownerId ? sql`sessions.owner_id = ${ownerId}` : sql`sessions.owner_id is null`
  const previewExpr = sql`(select msg.message->>'content' from messages msg
     where msg.session_id = sessions.id and msg.message->>'role' = 'user'
     order by msg.id asc limit 1)`

  // updated_at 的类型标注是 string，不是 Date——db.execute 是原生驱动
  // 结果，不经过 drizzle 的列类型映射，实际拿到的是 Postgres 自己的
  // 文本表示，下面 map 里会显式 new Date(...) 转换（详见那里的注释）。
  type Row = { id: string; updated_at: string; name: string | null; preview: string | null }

  // 没有搜索词时，preview 只用来展示，不参与过滤/排序——这时直接放在
  // 最外层 SELECT 列表里，Postgres 只会对 LIMIT/OFFSET 之后真正要返回
  // 的那一页行求值这个相关子查询，而不是对这个 owner 名下的每个会话都
  // 算一遍（每算一次都要去 messages 表按 session_id 找第一条用户消息）。
  //
  // 有搜索词时就没法这么偷懒了——必须先把每一行的 preview 算出来才能
  // 拿它去做 ilike 过滤，只能退回到"内层子查询先算、外层再过滤"的写法，
  // 多查 1 条（limit+1）用来判断 hasMore，省一次单独的 COUNT 查询。
  const result = trimmedSearch
    ? await withRetry(() =>
        db.execute<Row>(sql`
          select t.id, t.updated_at, t.name, t.preview from (
            select
              sessions.id as id,
              sessions.updated_at as updated_at,
              sessions.name as name,
              ${previewExpr} as preview
            from sessions
            where ${ownerFilter}
          ) t
          where t.name ilike ${'%' + trimmedSearch + '%'} or t.preview ilike ${'%' + trimmedSearch + '%'}
          order by t.updated_at desc
          limit ${limit + 1} offset ${offset}
        `),
      )
    : await withRetry(() =>
        db.execute<Row>(sql`
          select
            sessions.id as id,
            sessions.updated_at as updated_at,
            sessions.name as name,
            ${previewExpr} as preview
          from sessions
          where ${ownerFilter}
          order by sessions.updated_at desc
          limit ${limit + 1} offset ${offset}
        `),
      )

  const rows = result.rows
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    sessions: page.map((r) => ({ id: r.id, updatedAt: new Date(r.updated_at), name: r.name, preview: r.preview })),
    hasMore,
  }
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

// name 传 null（或调用方在 index.ts 里把空字符串 trim 成的 null）会清除
// 自定义标题，落回 listSessions 里算出来的 preview——调用方必须已经
// 校验过归属（比如先调用 resolveSessionAccess），这里不重复检查。
export async function renameSession(sessionId: string, name: string | null): Promise<void> {
  await withRetry(() => db.update(sessions).set({ name }).where(eq(sessions.id, sessionId)))
}

// messages/artifacts/attachments/usage_events 都对 sessions.id 设置了
// onDelete: 'cascade'（见 schema.ts），删这一行会把这个会话的历史消息、
// 产物元数据、附件元数据、用量记录一并删掉——R2 里的实际文件字节不受
// 影响，会变成孤儿对象，跟其他地方一样交给已经配置好的 R2 生命周期
// 规则（scripts/configure-r2-lifecycle.ts）自然过期清理，这里不用同步
// 处理。调用方必须已经校验过归属。
export async function deleteSession(sessionId: string): Promise<void> {
  await withRetry(() => db.delete(sessions).where(eq(sessions.id, sessionId)))
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

// 只统计消息数、不取正文——供 GET /api/sessions/:id/messages/count 使用。
// 调用方必须已经校验过归属（比如先调用 resolveSessionAccess）。跟
// loadMessageRows 不同，这里不做"会话不存在就创建"的兜底——能查计数
// 的场景下，调用方发起请求前，客户端本地必然已经有这个 sessionId，
// 说明会话行早就存在了。
export async function getSessionMessageCount(sessionId: string): Promise<number> {
  const rows = await withRetry(() =>
    db.select({ count: sql<number>`count(*)::int` }).from(messages).where(eq(messages.sessionId, sessionId)),
  )
  return rows[0]?.count ?? 0
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
  // 与 loadMessageRows 不同，这里不读取会话的全部历史行 —— 只读取
  // 系统消息（result[0]）和折叠点之后的尾部（下面按 cutoff 过滤）。
  // 已被折叠进 summary 的旧消息本来就不会发给模型，没必要先整段
  // 读进内存再在 JS 里 filter 掉，尤其是长会话下这部分行可能很多。
  const [sessionRow, systemRow] = await Promise.all([
    withRetry(() =>
      db
        .select({ summary: sessions.summary, summarizedThroughId: sessions.summarizedThroughId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .then((rows) => rows[0]),
    ),
    withRetry(() =>
      db
        .select({ id: messages.id, message: messages.message })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(messages.id)
        .limit(1)
        .then((rows) => rows[0]),
    ),
  ])

  // systemRow 为空意味着这是全新会话（还没有任何消息行）——退回到
  // loadMessageRows 原有的初始化路径，创建 session 行 + 系统消息。
  const resolvedSystemRow = systemRow ?? (await loadMessageRows(sessionId, ownerId))[0]

  const cutoff = sessionRow?.summarizedThroughId ?? resolvedSystemRow.id
  let tailRows = await withRetry(() =>
    db
      .select({ id: messages.id, message: messages.message })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), gt(messages.id, cutoff)))
      .orderBy(messages.id),
  )
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

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [resolvedSystemRow.message]
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
