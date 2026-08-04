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
import { MAX_VISION_IMAGE_BYTES, type PendingVisionImage } from './agent/tools/vision.js'
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

// 目前还没有任何产品功能会调用这个上限（参见 @autonoma/upload）——
// 这只是一个防滥用的宽松上限，并不是针对具体功能的真实限制。
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

// 一个空闲沙箱会被保留多久，以便该会话的下一条消息（参见 /api/agent/run）
// 能重新连接上它，超过这个时间 e2b 会自行回收。每次有请求用到它时都会重置
// 这个计时，所以持续来回对话会一直复用同一个沙箱；而没人再回来的会话就
// 会自然过期。
const SANDBOX_IDLE_TTL_MS = 10 * 60 * 1000

// `uploads/<owner>/<uuid>/<filename>` —— 按 owner 划分命名空间，
// 这样一个登录用户就无法对另一个用户尚未完成的上传任务执行
// complete/abort/append parts（下面的 ownsUploadKey 会做校验）。
// 当鉴权关闭时（本地开发场景）ownerId 会是 undefined，这与
// sessions/artifacts 里“无 owner”的约定一致，此时所有上传都会
// 归并到共享的 'anon' 命名空间下——这没关系，因为这种模式下本来
// 也不需要隔离。
function buildUploadKey(ownerId: string | undefined, filename: string): string {
  const safeName = filename.split(/[/\\]/).pop()?.trim() || 'file'
  return `uploads/${ownerId ?? 'anon'}/${crypto.randomUUID()}/${safeName}`
}

function ownsUploadKey(key: string, ownerId: string | undefined): boolean {
  return key.startsWith(`uploads/${ownerId ?? 'anon'}/`)
}

// 在 agent 循环开始之前，把每个附件从 R2 拉取并写入沙箱（是流式处理，
// 不会在本进程里整体缓冲——参见 storage.ts 的 getObjectStream），
// 然后返回一段简短的自然语言说明，附加到用户消息里，让模型知道
// 这些文件已经存在，并且这个事实会随对话历史一起持久化下来。
// 这里会再次校验 ownsUploadKey——否则客户端本可以随意传回任意
// R2 key，而不局限于自己上传命名空间下的 key，因为发送消息时
// `key` 是由客户端自行声明的（/api/uploads* 系列路由只在签发
// URL 时校验归属权）。
//
// 图片类附件多一步处理：写入沙箱后立刻再读回来（用的是和
// view_image 相同的 `files.read(..., {format: 'bytes'})` 调用），
// 这样这一轮的 runAgentLoop 调用就能立即把图片展示给视觉模型看，
// 不需要模型再额外调用一次工具才能看到刚上传的内容。体积过大的
// 图片会跳过自动预览（但仍然会写入沙箱——如果之后特意要求查看，
// view_image 仍可以明确地报错并说明原因，而不是让这个函数在这里
// 悄悄地尝试并以不同的方式出错）。
async function attachFilesToSandbox(
  sandbox: Sandbox,
  attachments: UploadedAttachment[],
  ownerId: string | undefined,
): Promise<{ note: string; visionImages: PendingVisionImage[] }> {
  if (attachments.length === 0) return { note: '', visionImages: [] }

  const ok: string[] = []
  const failed: string[] = []
  const tooLargeToPreview: string[] = []
  const visionImages: PendingVisionImage[] = []
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
      continue
    }

    if (attachment.mimeType.startsWith('image/')) {
      try {
        const bytes = await sandbox.files.read(safeName, { format: 'bytes', requestTimeoutMs: 60_000 })
        if (bytes.byteLength <= MAX_VISION_IMAGE_BYTES) {
          visionImages.push({ mimeType: attachment.mimeType, base64: Buffer.from(bytes).toString('base64'), label: safeName })
        } else {
          tooLargeToPreview.push(safeName)
        }
      } catch (err) {
        console.error('failed to read image attachment back for vision preview:', err)
      }
    }
  }

  const parts: string[] = []
  if (ok.length > 0) parts.push(`用户上传了以下文件，已放在沙箱当前目录：${ok.join('、')}`)
  if (failed.length > 0) parts.push(`以下文件读取失败，无法使用：${failed.join('、')}`)
  if (tooLargeToPreview.length > 0) {
    parts.push(`以下图片体积较大，未自动展示，如需查看请先在沙箱内压缩后用 view_image 查看：${tooLargeToPreview.join('、')}`)
  }
  const note = parts.length > 0 ? `\n\n（${parts.join('；')}）` : ''
  return { note, visionImages }
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

  // ?raw=1 会直接返回预签名的 R2 URL 本身，而不是做重定向——
  // 这是给那些用自己的 HTTP 客户端读取文件字节、而不是走浏览器
  // 导航的场景准备的（比如 react-pdf/pdf.js、papaparse，以及
  // Microsoft Office 在线预览的服务端 fetch）。这些调用方都不会
  // 带上我们的会话 cookie，所以没法直接访问这个需要鉴权的路由；
  // 它们需要提前拿到这个已经授权好的原始 URL。普通的
  // <img>/<video>/<a href> 用法则不受影响，仍然走重定向。
  if (c.req.query('raw') === '1') {
    return c.json({ url, name: artifact.name, mimeType: artifact.mimeType })
  }
  return c.redirect(url, 302)
})

// 单次直传 R2 的上传方式——与 @autonoma/upload 的
// createR2UploadAdapter 配套使用。这里只签发一个预签名的 PUT URL，
// 文件字节本身不会经过这台服务器。
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

// 分片直传 R2 的上传方式（用于大文件）——与 @autonoma/upload 的
// createR2MultipartUploadAdapter 配套使用。四个接口环绕着浏览器
// 对各分片的直传 PUT 请求：create（创建）、part-url（每个分片
// 调用一次）、complete（完成）、以及 abort（取消/失败时的清理）。
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

  // 客户端传上来的 sessionId 永远只是用来查找服务器此前已签发的会话
  // 的一个键，绝不会被直接采信当作真实会话使用。如果它对应不到当前
  // 登录用户拥有的会话，就重新生成一个，而不是信任客户端给的 ID。
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

    // 如果该会话的沙箱还存活就复用它（参见下面的 setSandboxId），
    // 而不是每次都付出冷启动 Sandbox.create() 的代价——这也是为什么
    // 前面某一轮生成的文件到了后面调用 export_artifact 时依然存在的
    // 原因。只要重连因为任何原因失败（过期、被回收、或从未存在过），
    // 就回退到创建一个全新的沙箱。
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
        // e2b 创建偶尔会因为瞬时网络错误而失败——值得先重试几次，
        // 再放弃并告知用户。
        sandbox = await withRetry(() => Sandbox.create({ timeoutMs: SANDBOX_IDLE_TTL_MS }), 3, 500)
      } catch (err) {
        console.error('Sandbox.create failed:', err)
        await sendError('沙箱环境创建失败，请稍后重试。')
        return
      }
    }

    try {
      const messages = await loadSessionMessagesForAgent(sessionId, ownerId)
      // 此时这一行记录必然已经存在（loadSessionMessagesForAgent 刚刚
      // 访问过它）——可以放心持久化保存这个会话归属的沙箱，这样这个
      // 对话里的下一条消息也能重新连接上它。
      await setSandboxId(sessionId, sandbox.sandboxId).catch((err) =>
        console.error('failed to persist sandboxId:', err),
      )
      const turnStart = messages.length
      const { note: attachmentNote, visionImages } = await attachFilesToSandbox(sandbox, attachments, ownerId)
      messages.push({ role: 'user', content: task + attachmentNote })

      try {
        for await (const event of runAgentLoop(messages, sandbox, sessionId, visionImages)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
        }
      } finally {
        // 即使出错也要把这一轮产生的内容持久化下来——runAgentLoop
        // 会就地修改 `messages`，所以就算这一轮没跑完，里面也已经有
        // 有价值的历史记录了。
        await appendMessages(sessionId, messages.slice(turnStart)).catch((err) =>
          console.error('failed to persist conversation turn:', err),
        )
      }
    } catch (err) {
      console.error(err)
      await sendError(err instanceof Error ? err.message : String(err))
    } finally {
      // 并不是把它杀掉——而是延长它的存活时间，这样这个会话在时间窗口
      // 内的下一条消息还能重新连接上同一个沙箱。没人再回来用的沙箱会
      // 通过 e2b 自身的超时机制自然过期；这里不需要做任何显式清理。
      await sandbox.setTimeout(SANDBOX_IDLE_TTL_MS).catch((err) => console.error('sandbox.setTimeout failed:', err))
    }
  })
})

await runMigrations()

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
