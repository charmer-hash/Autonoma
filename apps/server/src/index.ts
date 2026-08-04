import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import { Sandbox } from 'e2b'
import type {
  AgentEvent,
  MultipartCompleteRequest,
  MultipartCreateRequest,
  MultipartCreateResponse,
  MultipartPart,
  MultipartPartUrlRequest,
  PresignedUpload,
  PresignedUploadRequest,
  UploadedAttachment,
} from '@autonoma/shared'
import { runAgentLoop } from './agent/loop.js'
import { authenticate, clearSession, createSession, getOwnerId, isAuthenticated, requireAuth } from './auth.js'
import { getArtifactById } from './db/artifacts.js'
import { runMigrations } from './db/migrate.js'
import {
  appendMessages,
  getSandboxId,
  listSessions,
  loadSessionMessages,
  loadSessionMessagesForAgent,
  resolveSessionAccess,
  setSandboxId,
} from './db/sessions.js'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getObjectStream,
  getPresignedDownloadUrl,
  getPresignedPartUploadUrl,
  getPresignedUploadUrl,
} from './lib/storage.js'
import { withRetry } from './lib/retry.js'

// No product feature calls these yet (see @autonoma/upload) — a generous
// ceiling against abuse, not a real per-feature limit.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

// How long an idle sandbox is kept around for a session's next message to
// reconnect to (see /api/agent/run) before e2b reaps it on its own. Reset on
// every request that touches it, so an active back-and-forth keeps reusing
// the same sandbox indefinitely; a session nobody returns to just expires.
const SANDBOX_IDLE_TTL_MS = 10 * 60 * 1000

// `uploads/<owner>/<uuid>/<filename>` — owner-scoped so one login can't
// complete/abort/append parts to another's in-flight upload (checked by
// ownsUploadKey below). ownerId is undefined when auth is off (local dev,
// same "no owner" convention as sessions/artifacts), which collapses every
// upload into the shared 'anon' namespace — fine since there's no isolation
// to enforce in that mode anyway.
function buildUploadKey(ownerId: string | undefined, filename: string): string {
  const safeName = filename.split(/[/\\]/).pop()?.trim() || 'file'
  return `uploads/${ownerId ?? 'anon'}/${crypto.randomUUID()}/${safeName}`
}

function ownsUploadKey(key: string, ownerId: string | undefined): boolean {
  return key.startsWith(`uploads/${ownerId ?? 'anon'}/`)
}

// Pulls each attachment out of R2 and into the sandbox (streamed, never
// buffered whole in this process — see storage.ts's getObjectStream) before
// the agent loop starts, then returns a short natural-language note to
// append to the user's message so the model knows the files are there and
// the fact survives into persisted history. Re-checks ownsUploadKey here
// too — a client could otherwise hand back any R2 key, not just one from its
// own upload namespace, since the client is the one asserting `key` at send
// time (the /api/uploads* routes only enforce ownership at mint time).
async function attachFilesToSandbox(
  sandbox: Sandbox,
  attachments: UploadedAttachment[],
  ownerId: string | undefined,
): Promise<string> {
  if (attachments.length === 0) return ''

  const ok: string[] = []
  const failed: string[] = []
  for (const attachment of attachments) {
    const safeName = attachment.filename.split(/[/\\]/).pop()?.trim() || 'file'
    if (!ownsUploadKey(attachment.key, ownerId)) {
      failed.push(safeName)
      continue
    }
    try {
      const stream = await getObjectStream(attachment.key)
      await sandbox.files.write(safeName, stream)
      ok.push(safeName)
    } catch (err) {
      console.error('failed to pull attachment into sandbox:', err)
      failed.push(safeName)
    }
  }

  const parts: string[] = []
  if (ok.length > 0) parts.push(`用户上传了以下文件，已放在沙箱当前目录：${ok.join('、')}`)
  if (failed.length > 0) parts.push(`以下文件读取失败，无法使用：${failed.join('、')}`)
  return parts.length > 0 ? `\n\n（${parts.join('；')}）` : ''
}

const app = new Hono()

app.use('*', logger())

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

app.get('/api/artifacts/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Missing artifact id.' }, 400)
  const artifact = await getArtifactById(id)
  if (!artifact) return c.json({ error: '文件不存在。' }, 404)

  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(artifact.sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该文件。' }, 403)
  if (access === 'not_found') return c.json({ error: '文件不存在。' }, 404)

  const disposition = artifact.mimeType.startsWith('image/') || artifact.mimeType === 'application/pdf' ? 'inline' : 'attachment'
  const url = await getPresignedDownloadUrl(artifact.r2Key, {
    filename: artifact.name,
    mimeType: artifact.mimeType,
    disposition,
  })

  // ?raw=1 hands back the presigned R2 URL itself instead of redirecting —
  // needed by anything that reads the file's bytes with its own HTTP client
  // rather than following a browser navigation (react-pdf/pdf.js, papaparse,
  // and the Microsoft Office viewer's server-side fetch). None of those
  // carry our session cookie, so they can't hit this authenticated route
  // directly; they need the raw, already-authorized URL up front. Plain
  // <img>/<video>/<a href> usage keeps working unchanged via the redirect.
  if (c.req.query('raw') === '1') {
    return c.json({ url, name: artifact.name, mimeType: artifact.mimeType })
  }
  return c.redirect(url, 302)
})

// Single-shot direct-to-R2 upload — pairs with @autonoma/upload's
// createR2UploadAdapter. Mints a presigned PUT URL; the file bytes never
// touch this server.
app.post('/api/uploads', requireAuth, async (c) => {
  const body = await c.req.json<Partial<PresignedUploadRequest>>().catch(() => ({}) as Partial<PresignedUploadRequest>)
  const { filename, mimeType, size } = body
  if (!filename || !mimeType || typeof size !== 'number') {
    return c.json({ error: '缺少 filename / mimeType / size。' }, 400)
  }
  if (size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `文件过大，最大允许 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB。` }, 400)
  }

  const ownerId = await getOwnerId(c)
  const key = buildUploadKey(ownerId, filename)
  const url = await getPresignedUploadUrl(key, mimeType)
  const response: PresignedUpload = { url, key }
  return c.json(response)
})

// Multipart direct-to-R2 upload (large files) — pairs with
// @autonoma/upload's createR2MultipartUploadAdapter. Four calls bracket the
// browser's direct-to-R2 part PUTs: create, part-url (once per part),
// complete, and abort (cancel/failure cleanup).
app.post('/api/uploads/multipart/create', requireAuth, async (c) => {
  const body = await c.req.json<Partial<MultipartCreateRequest>>().catch(() => ({}) as Partial<MultipartCreateRequest>)
  const { filename, mimeType, size } = body
  if (!filename || !mimeType || typeof size !== 'number') {
    return c.json({ error: '缺少 filename / mimeType / size。' }, 400)
  }
  if (size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `文件过大，最大允许 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB。` }, 400)
  }

  const ownerId = await getOwnerId(c)
  const key = buildUploadKey(ownerId, filename)
  const uploadId = await createMultipartUpload(key, mimeType)
  const response: MultipartCreateResponse = { key, uploadId }
  return c.json(response)
})

app.post('/api/uploads/multipart/part-url', requireAuth, async (c) => {
  const body = await c.req
    .json<Partial<MultipartPartUrlRequest>>()
    .catch(() => ({}) as Partial<MultipartPartUrlRequest>)
  const { key, uploadId, partNumber } = body
  if (!key || !uploadId || typeof partNumber !== 'number') {
    return c.json({ error: '缺少 key / uploadId / partNumber。' }, 400)
  }
  const ownerId = await getOwnerId(c)
  if (!ownsUploadKey(key, ownerId)) return c.json({ error: '无权访问该上传任务。' }, 403)

  const url = await getPresignedPartUploadUrl(key, uploadId, partNumber)
  return c.json({ url })
})

app.post('/api/uploads/multipart/complete', requireAuth, async (c) => {
  const body = await c.req
    .json<Partial<MultipartCompleteRequest>>()
    .catch(() => ({}) as Partial<MultipartCompleteRequest>)
  const { key, uploadId, parts } = body
  if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return c.json({ error: '缺少 key / uploadId / parts。' }, 400)
  }
  const ownerId = await getOwnerId(c)
  if (!ownsUploadKey(key, ownerId)) return c.json({ error: '无权访问该上传任务。' }, 403)

  await completeMultipartUpload(key, uploadId, parts as MultipartPart[])
  return c.json({ ok: true })
})

app.post('/api/uploads/multipart/abort', requireAuth, async (c) => {
  const body = await c.req.json<{ key?: string; uploadId?: string }>().catch(() => ({}) as { key?: string; uploadId?: string })
  const { key, uploadId } = body
  if (!key || !uploadId) return c.json({ error: '缺少 key / uploadId。' }, 400)
  const ownerId = await getOwnerId(c)
  if (!ownsUploadKey(key, ownerId)) return c.json({ error: '无权访问该上传任务。' }, 403)

  await abortMultipartUpload(key, uploadId)
  return c.json({ ok: true })
})

app.post('/api/agent/run', requireAuth, async (c) => {
  const body = await c.req
    .json<{ task?: string; sessionId?: string; attachments?: UploadedAttachment[] }>()
    .catch(() => ({}) as { task?: string; sessionId?: string; attachments?: UploadedAttachment[] })
  const task = body.task?.trim()
  if (!task) {
    return c.json({ error: 'Missing "task" in request body.' }, 400)
  }
  const attachments = Array.isArray(body.attachments) ? body.attachments : []
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

    // Reuse this session's sandbox if it's still alive (see setSandboxId
    // below) instead of always paying for a cold Sandbox.create() — also
    // what lets a file generated in an earlier turn still be there for a
    // later export_artifact call. Falls back to a fresh sandbox whenever
    // reconnect fails for any reason (expired, reaped, never existed).
    let sandbox: Sandbox | undefined
    const existingSandboxId = await getSandboxId(sessionId).catch(() => null)
    if (existingSandboxId) {
      try {
        sandbox = await Sandbox.connect(existingSandboxId)
      } catch {
        sandbox = undefined
      }
    }
    if (!sandbox) {
      try {
        // e2b creation occasionally blips on a transient network error — worth
        // a couple of retries before giving up and telling the user.
        sandbox = await withRetry(() => Sandbox.create({ timeoutMs: SANDBOX_IDLE_TTL_MS }), 3, 500)
      } catch (err) {
        console.error('Sandbox.create failed:', err)
        await sendError('沙箱环境创建失败，请稍后重试。')
        return
      }
    }

    try {
      const messages = await loadSessionMessagesForAgent(sessionId, ownerId)
      // Row is guaranteed to exist now (loadSessionMessagesForAgent just
      // touched it) — safe to persist which sandbox this session owns, so
      // the next message in this conversation can reconnect to it too.
      await setSandboxId(sessionId, sandbox.sandboxId).catch((err) =>
        console.error('failed to persist sandboxId:', err),
      )
      const turnStart = messages.length
      const attachmentNote = await attachFilesToSandbox(sandbox, attachments, ownerId)
      messages.push({ role: 'user', content: task + attachmentNote })

      try {
        for await (const event of runAgentLoop(messages, sandbox, sessionId)) {
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
      // Not killed — extend its lease instead, so the next message in this
      // session (within the window) can reconnect to the same sandbox. A
      // sandbox nobody comes back to just expires on its own via e2b's
      // timeout; nothing here needs to explicitly clean it up.
      await sandbox.setTimeout(SANDBOX_IDLE_TTL_MS).catch((err) => console.error('sandbox.setTimeout failed:', err))
    }
  })
})

await runMigrations()

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
