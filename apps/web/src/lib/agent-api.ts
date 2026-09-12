import type { AgentEvent, UploadedAttachment } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'

// 每条 SSE 帧的 seq/runId 就是服务端 active-runs 缓冲区里的续传游标（见
// apps/server/src/agent/active-runs.ts）——原样透传给调用方，consoleStore
// 靠它们记住"看到哪条 run 的哪里了"，断线重连时告诉服务端从哪之后继续
// 补发。runId 是必须的，不能只靠 seq：同一个 sessionId 在其生命周期里会
// 顺序对应很多条不同的 run，seq 在每条新 run 里都从 0 重新计数——只带
// seq 重连，一旦服务端那边同一个 session 已经开始了下一轮全新的 run，
// 可能会把新一轮无关的内容当成上一轮的续集收下（见服务端 attachSink
// 的注释）。
export type AgentFrame = { seq: number; runId: string; event: AgentEvent }

// 连接在收到 done/error 这类终止事件之前就中断了——服务端的这一轮运行
// 本身不受影响、会继续跑完并落库（Hono 的 SSE 写入在连接已断开时会静默
// 吞掉异常，不会让 runAgentLoop 提前退出），只是这个连接看不到后续内容。
// 调用方应该带上 lastSeq/runId 去调用 reconnectAgent 续上，而不是重新
// 发起任务。
export class StreamDroppedError extends Error {
  lastSeq: number
  runId: string | undefined
  constructor(lastSeq: number, runId: string | undefined) {
    super('SSE 连接意外中断')
    this.name = 'StreamDroppedError'
    this.lastSeq = lastSeq
    this.runId = runId
  }
}

// 重连时这个 session 当前没有一条 id 匹配的正在进行的运行——要么它本来
// 就已经跑完并被持久化了，要么事件缓冲区已经过了宽限期被清理，要么
// 宽限期内已经开始了下一轮全新的 run。调用方应该退回到直接读取
// GET /api/sessions/:id 的持久化结果，而不是继续重试重连。
export class NoActiveRunError extends Error {
  constructor() {
    super('该会话当前没有正在进行的运行')
    this.name = 'NoActiveRunError'
  }
}

// 浏览器内置的 EventSource 只支持 GET，而 /api/agent/run 是 POST 请求，
// 所以我们从 fetch 流中手动解析 SSE 帧格式（data / id 两行，id 编码成
// `${runId}:${seq}`）。runAgent 和 reconnectAgent 共用这份底层解析逻辑。
async function* parseSseStream(res: Response): AsyncGenerator<AgentFrame> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let seq = -1
  let runId = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const lines = part.split('\n')
      const dataLine = lines.find((line) => line.startsWith('data: '))
      if (!dataLine) continue
      const idLine = lines.find((line) => line.startsWith('id: '))
      const idValue = idLine?.slice('id: '.length)
      // 服务端总是以 `${runId}:${seq}` 的格式写 id——runId（uuid）本身不
      // 含冒号，用第一个冒号切分即可，剩下的都是 seq 部分。
      const sepIndex = idValue?.indexOf(':') ?? -1
      if (idValue && sepIndex > 0) {
        runId = idValue.slice(0, sepIndex)
        const parsedSeq = Number(idValue.slice(sepIndex + 1))
        seq = Number.isFinite(parsedSeq) ? parsedSeq : seq + 1
      } else {
        seq += 1
      }

      const raw = dataLine.slice('data: '.length)
      try {
        yield { seq, runId, event: JSON.parse(raw) as AgentEvent }
      } catch {
        // 非 JSON 的内容只可能是 hono/streaming 自身默认的错误帧
        // （一个纯字符串消息）——把它当作我们自己的错误来处理。
        yield { seq, runId, event: { type: 'error', message: raw } }
      }
    }
  }
}

// 消费一条 SSE 流,并在流异常终止(未曾见过 done/error)时统一抛出
// StreamDroppedError,而不是让调用方各自判断"这到底是正常结束还是断线"。
//
// 这里刻意不把 `yield` 写在 try 块里——如果写在里面,消费方(比如
// consoleStore.ts 的 applyEvent)在处理某个事件时自己抛出的异常,会通过
// async generator 的机制被扔回这个 yield 所在的位置,从而被下面的 catch
// 误判成"网络断开",把一个真实的下游 bug 伪装成断线、触发不必要的重连/
// 轮询流程。只有 parseSseStream 的迭代器本身(也就是真正的网络读取)
// 抛出的异常才应该被重新分类成 StreamDroppedError。
async function* consumeStream(res: Response, initialSeq: number): AsyncGenerator<AgentFrame> {
  const iterator = parseSseStream(res)[Symbol.asyncIterator]()
  let lastSeq = initialSeq
  let lastRunId: string | undefined
  let sawTerminalEvent = false

  while (true) {
    let result: IteratorResult<AgentFrame>
    try {
      result = await iterator.next()
    } catch (err) {
      if (sawTerminalEvent) throw err
      throw new StreamDroppedError(lastSeq, lastRunId)
    }
    if (result.done) break

    const frame = result.value
    lastSeq = frame.seq
    lastRunId = frame.runId
    if (frame.event.type === 'done' || frame.event.type === 'error') sawTerminalEvent = true
    yield frame
  }

  if (!sawTerminalEvent) throw new StreamDroppedError(lastSeq, lastRunId)
}

// 审批模式下点击工具卡片上的批准/拒绝按钮时调用——唤醒服务端里
// 挂起等待的 runAgentLoop（见 agent/approvals.ts），同一条 SSE 连接
// 会在唤醒后继续把后续事件流回来，不需要这个函数的调用方自己处理。
export async function postApprovalDecision(sessionId: string, toolCallId: string, approved: boolean): Promise<void> {
  const res = await apiFetch('/api/agent/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, toolCallId, approved }),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, '提交决定失败，请重试'))
}

export async function stopAgent(sessionId: string): Promise<void> {
  const res = await apiFetch('/api/agent/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) })
  if (!res.ok) throw new Error(await readErrorMessage(res, '停止失败，请重试'))
}

export async function* runAgent(
  task: string,
  sessionId: string | undefined,
  attachments?: UploadedAttachment[],
  signal?: AbortSignal,
): AsyncGenerator<AgentFrame> {
  const res = await apiFetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, sessionId, attachments }),
    signal,
  })

  if (!res.ok || !res.body) {
    throw new Error(await readErrorMessage(res, `Request failed: ${res.status} ${res.statusText}`))
  }

  yield* consumeStream(res, -1)
}

// 断线后用来续上同一轮还在服务端跑着的运行,不会重新发起任务——见
// apps/server/src/index.ts 的 GET /api/agent/run/:sessionId/reconnect。
// runId 必须是断线前最后一次收到的那个,服务端用它确认"这条 run 是不是
// 我当初想重连的那一条"，而不只是这个 session 当前随便哪条 run。
export async function* reconnectAgent(sessionId: string, runId: string, afterSeq: number): AsyncGenerator<AgentFrame> {
  const res = await apiFetch(`/api/agent/run/${sessionId}/reconnect?runId=${encodeURIComponent(runId)}&after=${afterSeq}`)

  if (res.status === 404) throw new NoActiveRunError()
  if (!res.ok || !res.body) {
    throw new Error(await readErrorMessage(res, `Reconnect failed: ${res.status} ${res.statusText}`))
  }

  yield* consumeStream(res, afterSeq)
}
