import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { Sandbox } from 'e2b'
import type { AgentEvent } from '@autonoma/shared'
import { runAgentLoop } from './agent/loop.js'
import { authenticate, clearSession, createSession, getOwnerId, isAuthenticated, requireAuth } from './auth.js'
import { runMigrations } from './db/migrate.js'
import {
  appendMessages,
  listSessions,
  loadSessionMessages,
  loadSessionMessagesForAgent,
  resolveSessionAccess,
} from './db/sessions.js'
import { withRetry } from './lib/retry.js'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
    credentials: true,
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

app.post('/api/auth/login', async (c) => {
  const body = await c.req
    .json<{ username?: string; password?: string }>()
    .catch(() => ({}) as { username?: string; password?: string })
  const ownerId = await authenticate(body.username, body.password)
  if (!ownerId) {
    return c.json({ error: '用户名或密码错误' }, 401)
  }
  await createSession(c, ownerId)
  return c.json({ ok: true })
})

app.post('/api/auth/logout', (c) => {
  clearSession(c)
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => c.json({ authenticated: await isAuthenticated(c) }))

app.get('/api/sessions', requireAuth, async (c) => {
  const ownerId = await getOwnerId(c)
  const sessions = await listSessions(ownerId)
  return c.json({ sessions })
})

app.get('/api/sessions/:id', requireAuth, async (c) => {
  const sessionId = c.req.param('id')
  if (!sessionId) return c.json({ error: 'Missing session id.' }, 400)
  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)
  const messages = await loadSessionMessages(sessionId, ownerId)
  return c.json({ messages })
})

app.post('/api/agent/run', requireAuth, async (c) => {
  const body = await c.req
    .json<{ task?: string; sessionId?: string }>()
    .catch(() => ({}) as { task?: string; sessionId?: string })
  const task = body.task?.trim()
  if (!task) {
    return c.json({ error: 'Missing "task" in request body.' }, 400)
  }
  const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined
  const ownerId = await getOwnerId(c)

  // A client-supplied sessionId is only ever a lookup key into a session the
  // server already issued — never adopted as-is. If it doesn't resolve to
  // one this login owns, mint a fresh one instead of trusting the client's ID.
  let accessibleSessionId = requestedSessionId
  if (accessibleSessionId) {
    const access = await resolveSessionAccess(accessibleSessionId, ownerId)
    if (access === 'forbidden') {
      return c.json({ error: '无权访问该会话。' }, 403)
    }
    if (access === 'not_found') accessibleSessionId = undefined
  }
  const isNewSession = !accessibleSessionId
  const sessionId: string = accessibleSessionId ?? crypto.randomUUID()

  return streamSSE(c, async (stream) => {
    async function sendError(message: string) {
      const event: AgentEvent = { type: 'error', message }
      await stream.writeSSE({ event: 'error', data: JSON.stringify(event) })
    }

    if (isNewSession) {
      const event: AgentEvent = { type: 'session', sessionId }
      await stream.writeSSE({ event: 'session', data: JSON.stringify(event) })
    }

    let sandbox: Sandbox
    try {
      // e2b creation occasionally blips on a transient network error — worth
      // a couple of retries before giving up and telling the user.
      sandbox = await withRetry(() => Sandbox.create(), 3, 500)
    } catch (err) {
      console.error('Sandbox.create failed:', err)
      await sendError('沙箱环境创建失败，请稍后重试。')
      return
    }

    try {
      const messages = await loadSessionMessagesForAgent(sessionId, ownerId)
      const turnStart = messages.length
      messages.push({ role: 'user', content: task })

      try {
        for await (const event of runAgentLoop(messages, sandbox)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
        }
      } finally {
        // Persist whatever this turn produced even on error — runAgentLoop
        // mutates `messages` in place, so a partial turn still has useful
        // history in it.
        await appendMessages(sessionId, messages.slice(turnStart)).catch((err) =>
          console.error('failed to persist conversation turn:', err),
        )
      }
    } catch (err) {
      console.error(err)
      await sendError(err instanceof Error ? err.message : String(err))
    } finally {
      await sandbox.kill().catch((err) => console.error('sandbox.kill failed:', err))
    }
  })
})

await runMigrations()

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
