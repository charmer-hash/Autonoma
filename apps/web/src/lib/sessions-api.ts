import type { SessionSummary, StoredMessage } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await apiFetch('/api/sessions')
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  const data = (await res.json()) as { sessions: SessionSummary[] }
  return data.sessions
}

export async function getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  const res = await apiFetch(`/api/sessions/${sessionId}`)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load session: ${res.status}`))
  }
  const data = (await res.json()) as { messages: StoredMessage[] }
  return data.messages
}
