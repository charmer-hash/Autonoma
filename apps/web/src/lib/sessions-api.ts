import type { ListSessionsResponse, RenameSessionRequest, SessionMessageCountResponse, StoredMessage } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'

export async function listSessions(opts?: {
  limit?: number
  offset?: number
  search?: string
}): Promise<ListSessionsResponse> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.offset) params.set('offset', String(opts.offset))
  if (opts?.search) params.set('search', opts.search)
  const qs = params.toString()
  const res = await apiFetch(`/api/sessions${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  return (await res.json()) as ListSessionsResponse
}

export async function getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  const res = await apiFetch(`/api/sessions/${sessionId}`)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load session: ${res.status}`))
  }
  const data = (await res.json()) as { messages: StoredMessage[] }
  return data.messages
}

// 只拿消息数，不拿正文——供 consoleStore 的 run() 记一个"提交前基准值"
// 用（见那里的注释），比整段拉 getSessionMessages 再数 length 轻得多。
export async function getSessionMessageCount(sessionId: string): Promise<number> {
  const res = await apiFetch(`/api/sessions/${sessionId}/messages/count`)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load message count: ${res.status}`))
  }
  const data = (await res.json()) as SessionMessageCountResponse
  return data.count
}

// name 传 null（或空字符串）会清除自定义标题，落回显示服务端算出来的
// preview（第一条用户消息文本）。
export async function renameSession(sessionId: string, name: string | null): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name } satisfies RenameSessionRequest),
  })
  if (!res.ok) return { ok: false, error: await readErrorMessage(res, '重命名失败，请重试') }
  return { ok: true }
}

export async function deleteSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
  if (!res.ok) return { ok: false, error: await readErrorMessage(res, '删除失败，请重试') }
  return { ok: true }
}
