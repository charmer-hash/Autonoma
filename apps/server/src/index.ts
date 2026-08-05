import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
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
  MAX_SESSION_NAME_LENGTH,
  MIN_MAX_TURNS,
  MIN_SANDBOX_IDLE_MINUTES,
  type AgentEvent,
  type AgentSettings,
  type AgentSettingsResponse,
  type AuthMeResponse,
  type ListSessionsResponse,
  type LoginRequest,
  type MultipartCompleteRequest,
  type MultipartCreateRequest,
  type MultipartCreateResponse,
  type MultipartPart,
  type MultipartPartUrlRequest,
  type PresignedUpload,
  type PresignedUploadRequest,
  type PublicKeyResponse,
  type RenameSessionRequest,
  type SessionMessageCountResponse,
  type UpdateAgentSettingsRequest,
  type UpdateAgentSettingsResponse,
  type UploadedAttachment,
} from '@autonoma/shared'
import { resolveApproval } from './agent/approvals.js'
import {
  attachSink,
  clearSessionDeleting,
  detachSink,
  finishRun,
  isRunActive,
  isRunInProgress,
  markSessionDeleting,
  publish,
  tryStartRun,
  waitForFinish,
} from './agent/active-runs.js'
import { runAgentLoop } from './agent/loop.js'
import { MAX_VISION_IMAGE_BYTES, type PendingVisionImage } from './agent/tools/vision.js'
import { authenticate, clearSession, createSession, getOwnerId, isAuthenticated, isProd, requireAuth } from './auth.js'
import { decryptPassword, getPublicKeyBase64 } from './lib/login-crypto.js'
import { checkLoginRateLimit, clearLoginAttempts, recordLoginFailure, resolveClientIp } from './lib/login-rate-limit.js'
import { getLatestAttachmentByFilename, insertAttachment } from './db/attachments.js'
import { getDailyCostUsd } from './db/usage.js'
import { getArtifactById } from './db/artifacts.js'
import { runMigrations } from './db/migrate.js'
import {
  appendMessages,
  deleteSession,
  getSandboxId,
  getSessionMessageCount,
  listSessions,
  loadSessionMessages,
  loadSessionMessagesForAgent,
  renameSession,
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

// 生产环境下前后端通常不同源，必须显式配置允许的源——Hono 的 cors()
// 在 origin 为 '*' 时会原样发送 `Access-Control-Allow-Origin: *`，
// 浏览器规范规定这种字面量通配符跟 credentials:true 组合时，凭证请求
// 会被直接拒绝暴露给前端 JS（不是漏洞，但表现为所有登录态请求诡异地
// 全部失败，且没有任何明确报错指向"忘了配 CORS_ORIGIN"这个根因）。
// 与其留一个生产环境下实际上是死代码的默认值，不如启动时就直接报错。
const corsOrigin = process.env.CORS_ORIGIN?.split(',')
if (isProd && !corsOrigin) {
  throw new Error('CORS_ORIGIN 未设置——生产环境必须显式配置允许的跨域来源，而不是回退到会静默破坏所有登录态请求的通配符。')
}

const app = new Hono()

app.use('*', logger())

app.use(
  '*',
  cors({
    origin: corsOrigin ?? '*',
    credentials: true,
  }),
)

// CSRF 防护：登录态是 SameSite=None 的 cookie（跨域前后端所必需），单靠
// CORS_ORIGIN 挡不住——CORS 只限制"跨站页面能不能读到响应"，不限制"请求
// 能不能被发送、被服务端处理"。攻击者的页面完全可以用一个 Content-Type:
// text/plain 的简单请求（不触发预检）直接把 JSON body 打到
// /api/agent/run 之类的接口上，浏览器照样带上受害者的 cookie，Hono 的
// c.req.json() 也不检查 Content-Type，一样能被解析——所以之前是真的没有
// 防护。这里要求所有会改动状态的请求都必须带上一个自定义请求头：自定义
// 请求头不在 CORS 的"简单请求"白名单里，浏览器会强制先发一次预检
// （OPTIONS），预检能不能过是由上面的 CORS 配置（只认 CORS_ORIGIN 里列出
// 的源）决定的——一个不在白名单里的源，从一开始就拿不到这个头，请求也就
// 发不出去。GET/HEAD/OPTIONS 天然不改动状态，不需要这层校验；OPTIONS
// 还必须放行，否则预检本身都过不去。
app.use('*', async (c, next) => {
  const method = c.req.method
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (c.req.header('X-Requested-With') !== 'XMLHttpRequest') {
      return c.json({ error: '缺少必要的请求头。' }, 403)
    }
  }
  await next()
})

app.get('/health', (c) => c.json({ ok: true }))

// 前端登录前先拿这把公钥来加密密码——不缓存在别处，每次登录都现拿，
// 这样服务端重启导致密钥轮换时，下一次登录自然会用到新公钥，不需要
// 额外的失效/刷新机制。
app.get('/api/auth/public-key', (c) => {
  return c.json({ publicKey: getPublicKeyBase64() } satisfies PublicKeyResponse)
})

app.post('/api/auth/login', async (c) => {
  // 按来源 IP 限流——挡住对着这个接口狂刷用户名/密码组合的暴力破解
  // 尝试（见 lib/login-rate-limit.ts）。被锁定时直接拒绝、不再往下跑
  // RSA 解密和 scrypt 比对，省下无意义的计算。
  const ip = resolveClientIp(c.req.header('x-forwarded-for'), getConnInfo(c).remote.address)
  const rate = checkLoginRateLimit(ip)
  if (!rate.allowed) {
    return c.json({ error: `登录尝试过于频繁，请 ${Math.ceil(rate.retryAfterMs / 60_000)} 分钟后重试。` }, 429)
  }

  const body = await c.req
    .json<Partial<LoginRequest>>()
    .catch(() => ({}) as Partial<LoginRequest>)

  // 字段名叫 password，但 body.password 这时候还是 RSA 密文——先解密出
  // 明文，再送去跟数据库里的 scrypt 哈希比对（authenticate 内部做的事）。
  let decryptedPassword: string
  try {
    decryptedPassword = decryptPassword(body.password)
  } catch (err) {
    recordLoginFailure(ip)
    return c.json({ error: err instanceof Error ? err.message : '登录请求格式不正确。' }, 400)
  }

  const ownerId = await authenticate(body.username, decryptedPassword)
  if (!ownerId) {
    recordLoginFailure(ip)
    return c.json({ error: '用户名或密码错误' }, 401)
  }
  clearLoginAttempts(ip)
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

// limit/offset/search 都是可选的——不传就是原来的行为（前 50 条，
// 不过滤）。limit 上限 100，避免客户端传一个离谱的大数把整表拉回来。
app.get('/api/sessions', requireAuth, async (c) => {
  const ownerId = await getOwnerId(c)
  const rawLimit = Number(c.req.query('limit'))
  const rawOffset = Number(c.req.query('offset'))
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100 ? rawLimit : 50
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  const search = c.req.query('search')
  const { sessions, hasMore } = await listSessions(ownerId, { limit, offset, search })
  return c.json({
    sessions: sessions.map((s) => ({ ...s, updatedAt: s.updatedAt.toISOString() })),
    hasMore,
  } satisfies ListSessionsResponse)
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

// 只返回消息数，不带正文——consoleStore 在提交新任务前用它记一个"提交
// 前基准值"（见 apps/web/src/store/consoleStore.ts 的 run()），只在 SSE
// 掉线后走轮询兜底时才用得上，不值得为此拉一遍完整的消息历史。
app.get('/api/sessions/:id/messages/count', requireAuth, async (c) => {
  const sessionId = c.req.param('id')
  if (!sessionId) return c.json({ error: 'Missing session id.' }, 400)
  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)
  const count = await getSessionMessageCount(sessionId)
  return c.json({ count } satisfies SessionMessageCountResponse)
})

// name 传空字符串（trim 之后）表示清除自定义标题，落回显示 preview——
// 不是把空字符串当成一个"合法但空"的标题存起来。
app.patch('/api/sessions/:id', requireAuth, async (c) => {
  const sessionId = c.req.param('id')
  if (!sessionId) return c.json({ error: 'Missing session id.' }, 400)
  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)

  const body = await c.req.json<Partial<RenameSessionRequest>>().catch(() => ({}) as Partial<RenameSessionRequest>)
  const trimmed = typeof body.name === 'string' ? body.name.trim() : ''
  if (trimmed.length > MAX_SESSION_NAME_LENGTH) {
    return c.json({ error: `标题过长，最多 ${MAX_SESSION_NAME_LENGTH} 个字符。` }, 400)
  }
  await renameSession(sessionId, trimmed || null)
  return c.json({ ok: true })
})

app.delete('/api/sessions/:id', requireAuth, async (c) => {
  const sessionId = c.req.param('id')
  if (!sessionId) return c.json({ error: 'Missing session id.' }, 400)
  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)
  // 另一个标签页/设备可能正在这个会话里跑一轮对话——真删掉会导致那一轮
  // 跑完后落库时因为外键约束失败，静默丢掉这条回复。用 isRunInProgress
  // 而不是 isRunActive：后者对刚跑完、还在宽限期内等重连补读的记录也
  // 返回 true，会话正常应该能删，不该被最近一次已完成的对话挡住。
  if (isRunInProgress(sessionId)) {
    return c.json({ error: '该会话有一条消息正在处理中，请稍候再试。' }, 409)
  }
  // 紧接着 isRunInProgress 检查、不隔任何 await 地标记"正在删除"——堵住
  // 上面检查和下面真正的数据库删除之间那段 await 期间可能出现的竞态：
  // 另一个请求在这段时间里调用 tryStartRun（纯同步操作）抢先开始新一轮，
  // 见 active-runs.ts 里 markSessionDeleting 的注释。
  markSessionDeleting(sessionId)
  try {
    await deleteSession(sessionId)
  } finally {
    clearSessionDeleting(sessionId)
  }
  return c.json({ ok: true })
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

  // 同一个 session 同时只允许一条运行中的请求——两个标签页/一次网络重试
  // 几乎同时发消息时，第二个会在这里直接被拒绝，而不是两边都去连接/操作
  // 同一个沙箱。全新会话的 sessionId 是本次请求现生成的 uuid，天然不会
  // 和任何其它请求撞上，这里始终会成功。见 agent/active-runs.ts。runId
  // 是这条 run 的身份标识，之后会随每个 SSE 帧的 id 字段一起发给客户端，
  // 断线重连时客户端要原样带回来——见下面 reconnect 路由的注释。
  const runId = tryStartRun(sessionId)
  if (!runId) {
    return c.json({ error: '该会话有一条消息正在处理中，请稍候再试。' }, 409)
  }

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
    // 本连接自己就是这次运行的第一个订阅者——所有事件都经 publish() 走
    // active-runs 的缓冲区再分发到这里，而不是直接 stream.writeSSE，这样
    // 断线重连的客户端才能通过同一份缓冲区补上错过的内容（见
    // agent/active-runs.ts、下面新增的 GET /api/agent/run/:sessionId/reconnect）。
    // SSE 帧的 id 字段编码成 `${runId}:${seq}`——runId 让客户端断线重连时
    // 能告诉服务端"我要接上的是哪一条 run"，而不只是"这个 session 现在
    // 随便哪条 run"（同一个 session 生命周期里会顺序跑很多条 run，seq 在
    // 每条新 run 里都从 0 重新计数，只按 sessionId 找会有把新一轮的
    // 内容错当成旧一轮续集发出去的风险，见 active-runs.ts attachSink 的
    // 注释）。这里不需要改动 AgentEvent 本身的 JSON 结构。
    const sink = (buffered: { seq: number; event: AgentEvent }) =>
      stream.writeSSE({ event: buffered.event.type, data: JSON.stringify(buffered.event), id: `${runId}:${buffered.seq}` })
    // afterSeq=-1 且这条 run 刚创建、events 必然是空的——补发循环这里永远
    // 是 0 次迭代，attachSink 不会有实质性的等待，不需要像 reconnect 路由
    // 那样处理"补发过程中断线"的竞态（那边的补发经常有真正的历史事件要发）。
    await attachSink(sessionId, runId, -1, sink)
    // 断线后不用再对着一个死连接做无意义的写入尝试——但这不影响 run 本身
    // 继续跑下去（这正是这个功能的核心：run 不依赖任何一条具体连接），
    // 其它已经/后续重连的 sink 一样能收到事件，finishRun 仍会在下面的
    // 外层 finally 里正常执行，并发锁不会因为这条连接断开而卡住。
    stream.onAbort(() => detachSink(sessionId, sink))

    try {
      async function sendError(message: string) {
        publish(sessionId, { type: 'error', message })
      }

      if (isNewSession) {
        publish(sessionId, { type: 'session', sessionId })
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
            publish(sessionId, event)
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
    } finally {
      // 无论上面走到哪条路径（正常完成/沙箱创建失败提前 return/未预期的异常），
      // 都要在这里收尾：把这条运行标记为 finished（唤醒所有等待中的 reconnect
      // 连接、释放并发锁），并把本连接自己的 sink 摘掉。
      detachSink(sessionId, sink)
      finishRun(sessionId)
    }
  })
})

// 客户端 SSE 连接中途断开后用来重新接上同一条正在运行的 agent 循环——
// 不会重新发起任务，只是从自己记得的最后一个 seq 继续订阅
// active-runs 缓冲区（见 agent/active-runs.ts 顶部注释）。如果这个
// session 当前没有一条 id 匹配 runId 的活跃 run（本来就没在跑、已经跑完
// 且过了宽限期，或者宽限期内已经又开始了下一轮全新的 run——runId 会
// 对不上，见 active-runs.ts attachSink 的注释），返回 404，客户端应退回到
// GET /api/sessions/:id 读取最终的持久化结果。
app.get('/api/agent/run/:sessionId/reconnect', requireAuth, async (c) => {
  const sessionId = c.req.param('sessionId')
  const runId = c.req.query('runId')
  if (!sessionId || !runId) return c.json({ error: 'Missing sessionId / runId.' }, 400)
  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)

  if (!isRunActive(sessionId, runId)) {
    return c.json({ error: 'no_active_run' }, 404)
  }

  const afterSeqRaw = Number(c.req.query('after'))
  const afterSeq = Number.isFinite(afterSeqRaw) ? afterSeqRaw : -1

  return streamSSE(c, async (stream) => {
    const sink = (buffered: { seq: number; event: AgentEvent }) =>
      stream.writeSSE({ event: buffered.event.type, data: JSON.stringify(buffered.event), id: `${runId}:${buffered.seq}` })

    // onAbort 必须先注册、再调用 attachSink——这里的补发循环经常有真正的
    // 历史事件要一条条 await 写完，如果反过来，客户端恰好在补发过程中
    // 断开，这个 abort 会在监听器还没注册时就发生并被永久错过：
    // attachSink 补发完之后仍会把这个（其实已经死掉的）sink 注册进去，
    // 直到这条 run 结束才被动清理，期间白白多做一堆注定失败的写入尝试，
    // 这个 handler 本身也会一直悬着不提前退出。同一个监听器全程只注册
    // 这一次，既用来在补发阶段短路退出，也用来给下面的 Promise.race 提供
    // "连接断开了"这一信号。
    let aborted = false
    let resolveAbort: (() => void) | undefined
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve
    })
    stream.onAbort(() => {
      aborted = true
      detachSink(sessionId, sink)
      resolveAbort?.()
    })

    const attached = await attachSink(sessionId, runId, afterSeq, sink)
    if (aborted) return
    if (!attached) {
      // 上面 isRunActive 检查和这里 attachSink 之间存在极小的时间窗口——
      // run 恰好在这中间跑完并被清理掉。补一条明确的错误事件，让客户端
      // 当作一次真正的失败处理，而不是把它误判成又一次断线从而无限重试。
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: '重连失败，请刷新查看最新记录。' } satisfies AgentEvent) })
      return
    }
    if (attached.finished) return // 缓冲区里剩余的事件已经补发完，直接收尾即可

    await Promise.race([waitForFinish(sessionId), abortPromise])
  })
})

await runMigrations()

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
