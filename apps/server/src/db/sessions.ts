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
  // Written with an explicit alias/table-qualified `sessions.id` rather than
  // interpolating drizzle column objects — interpolating them here rendered
  // unqualified column names, which inside this correlated subquery resolved
  // to messages.id (bigint) instead of the outer sessions.id (text) and blew
  // up with "operator does not exist: text = bigint".
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

// Callers must check this before calling loadSessionMessages with a
// client-supplied sessionId — this function itself doesn't re-check, it
// trusts the caller already resolved 'owned'/'not_found'.
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

// Tolerates a session row that doesn't exist yet (brand-new sessionId,
// nothing persisted until loadSessionMessagesForAgent's first touch) —
// returns null rather than throwing, same as "no sandbox to reconnect to".
export async function getSandboxId(sessionId: string): Promise<string | null> {
  const rows = await withRetry(() =>
    db.select({ sandboxId: sessions.sandboxId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1),
  )
  return rows[0]?.sandboxId ?? null
}

// Callers must only call this once the session row is known to exist (e.g.
// after loadSessionMessagesForAgent) — this is a plain UPDATE, not an
// upsert, and silently affects zero rows otherwise.
export async function setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
  await withRetry(() => db.update(sessions).set({ sandboxId }).where(eq(sessions.id, sessionId)))
}

// Shared by both loadSessionMessages and loadSessionMessagesForAgent —
// queries every row for a session (including its id, needed for compaction
// bookkeeping), seeding a brand-new session with the system prompt on first
// touch.
async function loadMessageRows(sessionId: string, ownerId: string | undefined): Promise<MessageRow[]> {
  const rows = await withRetry(() =>
    db
      .select({ id: messages.id, message: messages.message })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.id),
  )

  if (rows.length > 0) return rows

  // Unseen sessionId — create the session row and seed it with the system prompt.
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

// Full, uncompacted conversation history — used by GET /api/sessions/:id so
// browsing an old session always shows the real original turns, never a
// summary standing in for folded-away messages. Compaction (see
// loadSessionMessagesForAgent) only changes what gets *sent to the model*;
// it never deletes rows, so this always reflects everything that happened.
export async function loadSessionMessages(
  sessionId: string,
  ownerId: string | undefined,
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const rows = await loadMessageRows(sessionId, ownerId)
  return rows.map((row) => row.message)
}

// History to actually send to the LLM for a turn — same underlying data as
// loadSessionMessages, but with older messages folded into a rolling
// summary once the unfolded tail grows past a size threshold (see
// agent/compaction.ts). Used by POST /api/agent/run only.
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
      // Best-effort: a compaction failure must not break the turn. Fall
      // back to sending the full unfolded tail this time; we'll retry
      // folding on a later call.
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
