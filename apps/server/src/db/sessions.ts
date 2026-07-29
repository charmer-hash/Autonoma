import { desc, eq, isNull, sql } from 'drizzle-orm'
import type OpenAI from 'openai'
import { createInitialMessages } from '../agent/loop.js'
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

export async function loadSessionMessages(
  sessionId: string,
  ownerId: string | undefined,
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const rows = await withRetry(() =>
    db
      .select({ message: messages.message })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.id),
  )

  if (rows.length > 0) return rows.map((row) => row.message)

  // Unseen sessionId — create the session row and seed it with the system prompt.
  const initial = createInitialMessages()
  await withRetry(() => db.insert(sessions).values({ id: sessionId, ownerId }).onConflictDoNothing())
  await withRetry(() => db.insert(messages).values({ sessionId, message: initial[0] }))
  return initial
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
