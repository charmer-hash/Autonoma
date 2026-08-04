import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { streamSSE } from 'hono/streaming'
import { Sandbox } from 'e2b'
import {
  DEFAULT_AGENT_SETTINGS,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MAX_TURNS,
  MAX_SANDBOX_IDLE_MINUTES,
  MIN_MAX_TURNS,
  MIN_SANDBOX_IDLE_MINUTES,
  type AgentEvent,
  type AgentSettings,
  type AgentSettingsResponse,
  type AuthMeResponse,
  type LoginRequest,
  type MultipartCompleteRequest,
  type MultipartCreateRequest,
  type MultipartCreateResponse,
  type MultipartPart,
  type MultipartPartUrlRequest,
  type PresignedUpload,
  type PresignedUploadRequest,
  type PublicKeyResponse,
  type UpdateAgentSettingsRequest,
  type UpdateAgentSettingsResponse,
  type UploadedAttachment,
} from '@autonoma/shared'
import { resolveApproval } from './agent/approvals.js'
import { runAgentLoop } from './agent/loop.js'
import { MAX_VISION_IMAGE_BYTES, type PendingVisionImage } from './agent/tools/vision.js'
import { authenticate, clearSession, createSession, getOwnerId, isAuthenticated, requireAuth } from './auth.js'
import { decryptPassword, getPublicKeyBase64 } from './lib/login-crypto.js'
import { getLatestAttachmentByFilename, insertAttachment } from './db/attachments.js'
import { getDailyCostUsd } from './db/usage.js'
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
import { getAgentSettings, getUsernameById, updateAgentSettings } from './db/users.js'
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

// 每个用户每天（滚动 24 小时）最多花费多少美元——基于 OpenRouter 返回的
// 真实 cost，见 agent/loop.ts 里 insertUsageEvent 的调用。
const DAILY_COST_LIMIT_USD = Number(process.env.DAILY_COST_LIMIT_USD ?? 5)


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
//
// 每个附件在校验通过 ownsUploadKey 之后，会立刻把 R2 key 落库
// （db/attachments.ts）——放在尝试写入沙箱之前，是因为浏览器此时已经
// 把文件直传到 R2 了，跟接下来这一步沙箱写入是否成功无关；这样哪怕
// 沙箱写入网络抖动失败，数据库里依然留着可以恢复的记录。这条记录也是
// view_image 在沙箱过期、文件已经找不到时的 R2 回退依据。
async function attachFilesToSandbox(
  sandbox: Sandbox,
  sessionId: string,
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

    await insertAttachment({
      id: crypto.randomUUID(),
      sessionId,
      filename: safeName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      r2Key: attachment.key,
    }).catch((err) => console.error('failed to persist attachment record:', err))

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
        // 先问沙箱里这份文件实际写入了多大——不能信 attachment.size，
        // 那是上传时客户端自己声明的，从未被服务端验证过（预签名 PUT
        // 的字节直接从浏览器发往 R2，不经过这台服务器）。用真实大小
        // 判断要不要读进内存，而不是先整个读完再检查。
        const info = await sandbox.files.getInfo(safeName, { requestTimeoutMs: 60_000 })
        if (info.size > MAX_VISION_IMAGE_BYTES) {
          tooLargeToPreview.push(safeName)
        } else {
          const bytes = await sandbox.files.read(safeName, { format: 'bytes', requestTimeoutMs: 60_000 })
          visionImages.push({ mimeType: attachment.mimeType, base64: Buffer.from(bytes).toString('base64'), label: safeName })
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

// 前端登录前先拿这把公钥来加密密码——不缓存在别处，每次登录都现拿，
// 这样服务端重启导致密钥轮换时，下一次登录自然会用到新公钥，不需要
// 额外的失效/刷新机制。
app.get('/api/auth/public-key', (c) => {
  return c.json({ publicKey: getPublicKeyBase64() } satisfies PublicKeyResponse)
})

app.post('/api/auth/login', async (c) => {
  const body = await c.req
    .json<Partial<LoginRequest>>()
    .catch(() => ({}) as Partial<LoginRequest>)

  // 字段名叫 password，但 body.password 这时候还是 RSA 密文——先解密出
  // 明文，再送去跟数据库里的 scrypt 哈希比对（authenticate 内部做的事）。
  let decryptedPassword: string
  try {
    decryptedPassword = decryptPassword(body.password)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '登录请求格式不正确。' }, 400)
  }

  const ownerId = await authenticate(body.username, decryptedPassword)
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

app.get('/api/auth/me', async (c) => {
  const authenticated = await isAuthenticated(c)
  if (!authenticated) return c.json({ authenticated } satisfies AuthMeResponse)
  const ownerId = await getOwnerId(c)
  const username = ownerId ? await getUsernameById(ownerId) : undefined
  return c.json({ authenticated, username } satisfies AuthMeResponse)
})

app.get('/api/settings', requireAuth, async (c) => {
  const ownerId = await getOwnerId(c)
  const settings = ownerId ? await getAgentSettings(ownerId) : DEFAULT_AGENT_SETTINGS
  return c.json(settings satisfies AgentSettingsResponse)
})

app.put('/api/settings', requireAuth, async (c) => {
  const body = await c.req
    .json<Partial<UpdateAgentSettingsRequest>>()
    .catch(() => ({}) as Partial<UpdateAgentSettingsRequest>)

  const customInstructions = typeof body.customInstructions === 'string' ? body.customInstructions : ''
  if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
    return c.json({ error: `自定义指令过长，最多 ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} 个字符。` }, 400)
  }
  if (body.approvalMode !== 'auto' && body.approvalMode !== 'confirm') {
    return c.json({ error: '审批模式取值不合法。' }, 400)
  }
  const maxTurns = Number(body.maxTurns)
  if (!Number.isInteger(maxTurns) || maxTurns < MIN_MAX_TURNS || maxTurns > MAX_MAX_TURNS) {
    return c.json({ error: `单轮最大步数必须在 ${MIN_MAX_TURNS}-${MAX_MAX_TURNS} 之间。` }, 400)
  }
  if (body.modelChoice !== 'default' && body.modelChoice !== 'grok') {
    return c.json({ error: '模型选择取值不合法。' }, 400)
  }
  const sandboxIdleMinutes = Number(body.sandboxIdleMinutes)
  if (
    !Number.isInteger(sandboxIdleMinutes) ||
    sandboxIdleMinutes < MIN_SANDBOX_IDLE_MINUTES ||
    sandboxIdleMinutes > MAX_SANDBOX_IDLE_MINUTES
  ) {
    return c.json({ error: `沙箱空闲保留时长必须在 ${MIN_SANDBOX_IDLE_MINUTES}-${MAX_SANDBOX_IDLE_MINUTES} 分钟之间。` }, 400)
  }

  const settings: AgentSettings = {
    customInstructions: customInstructions.trim(),
    approvalMode: body.approvalMode,
    maxTurns,
    codeExecEnabled: Boolean(body.codeExecEnabled),
    webSearchEnabled: Boolean(body.webSearchEnabled),
    visionEnabled: Boolean(body.visionEnabled),
    modelChoice: body.modelChoice,
    conciseReplies: Boolean(body.conciseReplies),
    sandboxIdleMinutes,
  }

  const ownerId = await getOwnerId(c)
  if (!ownerId) {
    // 鉴权关闭时没有账号可关联——不报错，但也没法持久化，前端会据
    // persisted: false 提示用户这条设置不会被保存。
    return c.json({ ok: true, persisted: false } satisfies UpdateAgentSettingsResponse)
  }
  await updateAgentSettings(ownerId, settings)
  return c.json({ ok: true, persisted: true } satisfies UpdateAgentSettingsResponse)
})

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

// 给控制台里展示用户上传图片的缩略图用——跟 GET /api/artifacts/:id
// 是同一个鉴权 + 预签名重定向模式，区别只是这里按 (sessionId, 文件名)
// 查，而不是按一个客户端已知的 id 查（前端历史消息里从来就没有过
// attachment 的 id，只有从持久化的提示文字里解析出来的文件名——见
// apps/web/src/lib/blocks.ts）。同一文件名在这个 session 里上传过
// 多次时，取最新的一份。
app.get('/api/sessions/:sessionId/attachments/:filename', requireAuth, async (c) => {
  const sessionId = c.req.param('sessionId')
  const filename = c.req.param('filename')
  if (!sessionId || !filename) return c.json({ error: 'Missing sessionId / filename.' }, 400)

  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)

  const record = await getLatestAttachmentByFilename(sessionId, filename)
  if (!record) return c.json({ error: '文件不存在。' }, 404)

  const disposition = record.mimeType.startsWith('image/') ? 'inline' : 'attachment'
  const url = await getPresignedDownloadUrl(record.r2Key, {
    filename: record.filename,
    mimeType: record.mimeType,
    disposition,
  })
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

// 审批模式（AgentSettings.approvalMode === 'confirm'）下，run_command/write_file/
// export_artifact 执行前会先在 SSE 里发出 approval_required 事件并挂起等待——
// 这个路由就是前端点批准/拒绝按钮时唤醒它的入口，见 agent/approvals.ts。
app.post('/api/agent/approve', requireAuth, async (c) => {
  const body = await c.req
    .json<{ sessionId?: string; toolCallId?: string; approved?: boolean }>()
    .catch(() => ({}) as { sessionId?: string; toolCallId?: string; approved?: boolean })
  const { sessionId, toolCallId, approved } = body
  if (!sessionId || !toolCallId || typeof approved !== 'boolean') {
    return c.json({ error: '缺少 sessionId / toolCallId / approved。' }, 400)
  }

  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)

  const resolved = resolveApproval(`${sessionId}:${toolCallId}`, approved)
  if (!resolved) return c.json({ error: '该操作已被处理或已超时。' }, 404)
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

  // 每日花费上限（滚动 24 小时窗口，不是自然日）——放在这里、沙箱创建
  // 之前检查，这样一个已经超额的请求不会还去白白付一次沙箱冷启动的
  // 成本。鉴权关闭时 ownerId 是 undefined，不做额度控制（本地开发场景，
  // 跟这个项目里"无 owner = 无隔离"的既有约定一致）。
  if (ownerId) {
    const spentToday = await getDailyCostUsd(ownerId).catch(() => 0)
    if (spentToday >= DAILY_COST_LIMIT_USD) {
      return c.json({ error: `今日额度已用完（$${DAILY_COST_LIMIT_USD.toFixed(2)}/天），请稍后再试。` }, 429)
    }
  }

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

  // 提前一次性加载好，供下面的沙箱创建/超时设置和 runAgentLoop 共用——
  // 读取失败（数据库瞬时抖动）不应该让整个任务跑不起来，静默回退到默认设置。
  const settings: AgentSettings = ownerId
    ? await getAgentSettings(ownerId).catch((err) => {
        console.error('failed to load agent settings:', err)
        return DEFAULT_AGENT_SETTINGS
      })
    : DEFAULT_AGENT_SETTINGS
  const sandboxIdleTtlMs = settings.sandboxIdleMinutes * 60_000

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
        sandbox = await withRetry(() => Sandbox.create({ timeoutMs: sandboxIdleTtlMs }), 3, 500)
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
      const { note: attachmentNote, visionImages } = await attachFilesToSandbox(sandbox, sessionId, attachments, ownerId)
      messages.push({ role: 'user', content: task + attachmentNote })

      try {
        for await (const event of runAgentLoop(messages, sandbox, sessionId, visionImages, settings, ownerId)) {
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
      await sandbox.setTimeout(sandboxIdleTtlMs).catch((err) => console.error('sandbox.setTimeout failed:', err))
    }
  })
})

await runMigrations()

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
