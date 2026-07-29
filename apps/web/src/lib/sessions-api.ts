import type { SessionSummary, StoredMessage } from '@autonoma/shared'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${API_URL}/api/sessions`, { credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  const data = (await res.json()) as { sessions: SessionSummary[] }
  return data.sessions
}

export async function getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}`, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Failed to load session: ${res.status}`)
  }
  const data = (await res.json()) as { messages: StoredMessage[] }
  return data.messages
}
