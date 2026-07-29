import type { AgentEvent } from '@autonoma/shared'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

// The browser's built-in EventSource only supports GET, and /api/agent/run is a
// POST, so we parse the `data: ...\n\n` SSE framing by hand from a fetch stream.
export async function* runAgent(
  task: string,
  sessionId: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${API_URL}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ task, sessionId }),
    signal,
  })

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Request failed: ${res.status} ${res.statusText}`)
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
        // A non-JSON payload can only be hono/streaming's own default error
        // frame (a bare message string) — treat it the same as our own.
        yield { type: 'error', message: raw }
      }
    }
  }
}
