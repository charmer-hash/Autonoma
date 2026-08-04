import type { AgentEvent, UploadedAttachment } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'

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

// 浏览器内置的 EventSource 只支持 GET，而 /api/agent/run 是 POST 请求，
// 所以我们从 fetch 流中手动解析 `data: ...\n\n` 这种 SSE 帧格式。
export async function* runAgent(
  task: string,
  sessionId: string | undefined,
  attachments?: UploadedAttachment[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const res = await apiFetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, sessionId, attachments }),
    signal,
  })

  if (!res.ok || !res.body) {
    throw new Error(await readErrorMessage(res, `Request failed: ${res.status} ${res.statusText}`))
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const dataLine = part.split('\n').find((line) => line.startsWith('data: '))
      if (!dataLine) continue
      const raw = dataLine.slice('data: '.length)
      try {
        yield JSON.parse(raw) as AgentEvent
      } catch {
        // 非 JSON 的内容只可能是 hono/streaming 自身默认的错误帧
        // （一个纯字符串消息）——把它当作我们自己的错误来处理。
        yield { type: 'error', message: raw }
      }
    }
  }
}
