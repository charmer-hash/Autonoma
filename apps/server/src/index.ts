import { Hono } from 'hono'
import { configureApp } from './app-setup.js'
import { uploadsRouter, ownsUploadKey } from './routes/uploads.js'
import { authRouter } from './routes/auth.js'
import { sessionsRouter } from './routes/sessions.js'
import { streamSSE } from 'hono/streaming'
import { Sandbox } from 'e2b'
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentEvent,
  type UploadedAttachment,
} from '@autonoma/shared'
import { resolveApproval } from './agent/approvals.js'
import {
  attachSink,
  cancelRun,
  detachSink,
  finishRun,
  isRunActive,
  isRunCancelled,
  getRunSignal,
  publish,
  tryStartRun,
  waitForFinish,
} from './agent/active-runs.js'
import { runAgentLoop } from './agent/loop.js'
import { createLazySandbox } from './agent/lazy-sandbox.js'
import { MAX_VISION_IMAGE_BYTES, type PendingVisionImage } from './agent/tools/vision.js'
import { getOwnerId, requireAuth } from './auth.js'
import { getLatestAttachmentByFilename, insertAttachment } from './db/attachments.js'
import { getDailyCostUsd } from './db/usage.js'
import {
  appendMessages,
  initializeSessionForAgent,
  deleteSession,
  getSandboxId,
  loadSessionMessagesForAgent,
  resolveSessionAccess,
  setSandboxId,
} from './db/sessions.js'
import { getAgentSettings, getUsernameById, updateAgentSettings } from './db/users.js'
import {
  getObjectStream,
  getPresignedDownloadUrl,
} from './lib/storage.js'
import { withRetry } from './lib/retry.js'

const DAILY_COST_LIMIT_USD = Number(process.env.DAILY_COST_LIMIT_USD ?? 5)

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

export const app = new Hono()

configureApp(app)

app.get('/health', (c) => c.json({ ok: true }))

app.route('/api/auth', authRouter)

app.route('/api/sessions', sessionsRouter)

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
app.route('/api/uploads', uploadsRouter)

app.get('/api/settings', requireAuth, async (c) => {
  const ownerId = await getOwnerId(c)
  if (!ownerId) return c.json(DEFAULT_AGENT_SETTINGS)
  return c.json(await getAgentSettings(ownerId))
})

app.put('/api/settings', requireAuth, async (c) => {
  const ownerId = await getOwnerId(c)
  if (!ownerId) return c.json({ ok: true, persisted: false })
  const settings = await c.req.json<typeof DEFAULT_AGENT_SETTINGS>().catch(() => null)
  if (!settings) return c.json({ error: '设置格式不正确。' }, 400)
  await updateAgentSettings(ownerId, settings)
  return c.json({ ok: true, persisted: true })
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

app.post('/api/agent/stop', requireAuth, async (c) => {
  const body = await c.req.json<{ sessionId?: string }>().catch(() => ({}) as { sessionId?: string })
  if (!body.sessionId) return c.json({ error: '缺少 sessionId。' }, 400)
  const ownerId = await getOwnerId(c)
  const access = await resolveSessionAccess(body.sessionId, ownerId)
  if (access === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (access === 'not_found') return c.json({ error: '会话不存在。' }, 404)
  return c.json({ ok: cancelRun(body.sessionId) })
})

app.post('/api/agent/run', requireAuth, async (c) => {
  const requestStartedAt = Date.now()
  const stageLabels: Record<string, string> = {
    daily_cost: '读取每日额度',
    settings: '读取 Agent 设置',
    session_access: '检查会话权限',
    history_init: '初始化历史记录',
    history_load: '加载历史记录',
    unused_session_cleanup: '清理未使用会话',
    sandbox_lookup: '查找沙箱',
    sandbox_connect: '连接沙箱',
    sandbox_create: '创建沙箱',
    sandbox_persist: '保存沙箱信息',
    attachments: '处理附件',
    messages_persist: '保存对话消息',
    sandbox_keepalive: '延长沙箱有效期',
  }
  const perf = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now()
    let ok = false
    try {
      const result = await operation()
      ok = true
      return result
    } finally {
      console.info(`[耗时] ${stageLabels[stage] ?? stage} agent.${stage}`, { requestId, durationMs: Date.now() - startedAt, ok })
    }
  }
  const requestId = crypto.randomUUID()
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
  // 用户名按已验证的 ownerId 缓存，避免每轮增加身份查询。
  const isAdmin = ownerId ? (await getUsernameById(ownerId).catch(() => undefined)) === 'admin' : false

  // 独立读取并行启动。历史中的付费摘要仍要等待额度检查通过。
  const quotaPromise = ownerId && !isAdmin
    ? perf('daily_cost', () => getDailyCostUsd(ownerId)).catch(() => 0)
    : Promise.resolve(0)
  // admin 直接使用默认设置，省去设置读取和缓存访问。
  const settingsPromise = ownerId && !isAdmin
    ? perf('settings', () => getAgentSettings(ownerId)).catch((err) => {
      console.error('failed to load agent settings:', err)
      return DEFAULT_AGENT_SETTINGS
    })
    : Promise.resolve(DEFAULT_AGENT_SETTINGS)

  let lockedSessionId: string | undefined
  let newSessionId: string | undefined
  const contextPromise = (async () => {
    let accessibleSessionId = requestedSessionId
    if (accessibleSessionId) {
      const access = isAdmin ? 'owned' : await perf('session_access', () => resolveSessionAccess(accessibleSessionId!, ownerId))
      if (access === 'forbidden') return { error: '无权访问该会话。', status: 403 as const }
      if (access === 'not_found') accessibleSessionId = undefined
    }
    const isNewSession = !accessibleSessionId
    const sessionId = accessibleSessionId ?? crypto.randomUUID()
    // 先验证归属并取得运行锁，再进行任何历史读取或摘要写入。
    const runId = tryStartRun(sessionId)
    if (!runId) return { error: '该会话有一条消息正在处理中，请稍候再试。', status: 409 as const }
    lockedSessionId = sessionId
    if (isNewSession) newSessionId = sessionId
    const messagesPromise = isNewSession
      ? perf('history_init', () => initializeSessionForAgent(sessionId, ownerId))
      : perf('history_load', () => loadSessionMessagesForAgent(
        sessionId, ownerId, async () => isAdmin || await quotaPromise < DAILY_COST_LIMIT_USD,
      ))
    return { sessionId, runId, isNewSession, messages: messagesPromise }
  })()

  // 等待所有准备操作结束后才释放锁，防止失败分支仍有后台写入。
  const [quotaResult, contextResult] = await Promise.allSettled([quotaPromise, contextPromise])
  const cleanupPreparation = async () => {
    try {
      if (newSessionId) {
        await perf('unused_session_cleanup', () => deleteSession(newSessionId!)).catch((err) =>
          console.error('failed to clean up unused new session:', err))
      }
    } finally {
      if (lockedSessionId) finishRun(lockedSessionId)
    }
  }
  const waitForContextMessages = async () => {
    if (contextResult.status === 'fulfilled' && !('error' in contextResult.value)) {
      await contextResult.value.messages.catch(() => {})
    }
  }
  if (!isAdmin && quotaResult.status === 'fulfilled' && quotaResult.value >= DAILY_COST_LIMIT_USD) {
    await waitForContextMessages()
    await cleanupPreparation()
    return c.json({ error: `今日额度已用完（$${DAILY_COST_LIMIT_USD.toFixed(2)}/天），请稍后再试。` }, 429)
  }
  if (quotaResult.status === 'rejected' || contextResult.status === 'rejected') {
    await waitForContextMessages()
    await cleanupPreparation()
    const failure = [quotaResult, contextResult].find((result) => result.status === 'rejected')
    console.error('agent preparation failed:', failure)
    return c.json({ error: '会话准备失败，请稍后重试。' }, 500)
  }
  const context = contextResult.value
  if ('error' in context) {
    await waitForContextMessages()
    await cleanupPreparation()
    return c.json({ error: context.error }, context.status)
  }
  const { sessionId, runId, isNewSession, messages: messagesPromise } = context

  return streamSSE(c, async (stream) => {
    const runStartedAt = requestStartedAt
    console.info('[耗时] SSE 连接已建立 agent.sse_open', { requestId, sessionId, runId, sinceRequestMs: Date.now() - runStartedAt })
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
      const [settings, messages] = await Promise.all([settingsPromise, messagesPromise])
      console.info('[耗时] 准备阶段完成 agent.preparation_complete', {
        requestId, sessionId, runId, isNewSession, durationMs: Date.now() - requestStartedAt,
      })
      const sandboxIdleTtlMs = settings.sandboxIdleMinutes * 60_000

      async function sendError(message: string) {
        publish(sessionId, { type: 'error', message })
      }

      if (isNewSession) {
        publish(sessionId, { type: 'session', sessionId })
      }

      // The session row must exist before lazy initialization persists its sandbox ID.
      const lazySandbox = createLazySandbox(async () => {
        const startedAt = Date.now()
        const existingSandboxId = isNewSession ? null : await perf('sandbox_lookup', () => getSandboxId(sessionId)).catch(() => null)
        let sandbox: Sandbox | undefined
        let reused = false
        if (existingSandboxId) {
          try {
            sandbox = await perf('sandbox_connect', () => Sandbox.connect(existingSandboxId))
            reused = true
          } catch {
            sandbox = undefined
          }
        }
        if (!sandbox) {
          sandbox = await perf('sandbox_create', () =>
            withRetry(() => Sandbox.create({ timeoutMs: sandboxIdleTtlMs }), 3, 500))
        }
        const sandboxId = sandbox.sandboxId
        await perf('sandbox_persist', () => setSandboxId(sessionId, sandboxId)).catch((err) =>
          console.error('failed to persist sandboxId:', err))
        console.info('[耗时] 沙箱就绪 agent.sandbox_ready', {
          requestId, sessionId, runId, durationMs: Date.now() - startedAt, reused,
        })
        return sandbox
      })

      try {
        const turnStart = messages.length
        const { note: attachmentNote, visionImages } = attachments.length > 0
          ? await perf('attachments', async () => attachFilesToSandbox(await lazySandbox.get(), sessionId, attachments, ownerId))
          : { note: '', visionImages: [] }
        messages.push({ role: 'user', content: task + attachmentNote })

        try {
          const modelStartedAt = Date.now()
          console.info('[耗时] 即将进入 Agent 主循环 agent.prepared', { requestId, sessionId, runId, durationMs: modelStartedAt - runStartedAt, messageCount: messages.length })
          let firstEvent = true
          for await (const event of runAgentLoop(messages, lazySandbox.get, sessionId, visionImages, settings, ownerId, () => isRunCancelled(sessionId), getRunSignal(sessionId, runId), runId)) {
            if (firstEvent) {
              console.info('[耗时] 首个前端事件 agent.first_event', { requestId, sessionId, runId, eventType: event.type, durationMs: Date.now() - modelStartedAt, sinceRequestMs: Date.now() - runStartedAt })
              firstEvent = false
            }
            publish(sessionId, event)
          }
          console.info('[耗时] Agent 主循环完成 agent.loop_complete', { requestId, sessionId, runId, sandboxUsed: Boolean(lazySandbox.peek()), modelDurationMs: Date.now() - modelStartedAt, totalMs: Date.now() - runStartedAt })
        } finally {
          // 即使出错也要把这一轮产生的内容持久化下来——runAgentLoop
          // 会就地修改 `messages`，所以就算这一轮没跑完，里面也已经有
          // 有价值的历史记录了。
          await perf('messages_persist', () => appendMessages(sessionId, messages.slice(turnStart))).catch((err) =>
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
        const sandbox = lazySandbox.peek()
        if (sandbox) {
          await perf('sandbox_keepalive', () => sandbox.setTimeout(sandboxIdleTtlMs)).catch((err) => console.error('sandbox.setTimeout failed:', err))
        }
      }
    } finally {
      // 无论上面走到哪条路径（正常完成/沙箱创建失败提前 return/未预期的异常），
      // 都要在这里收尾：把这条运行标记为 finished（唤醒所有等待中的 reconnect
      // 连接、释放并发锁），并把本连接自己的 sink 摘掉。
      detachSink(sessionId, sink)
      finishRun(sessionId)
      console.info('[耗时] Agent 请求全部完成 agent.request_complete', { requestId, sessionId, runId, totalMs: Date.now() - runStartedAt })
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
