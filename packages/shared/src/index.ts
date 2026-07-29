// Event shape streamed from apps/server's agent loop over SSE and consumed
// by apps/web. Kept as a type-only export — erased at compile time, no
// runtime dependency between the two apps.
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'document'; name: string; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

// Wire shape of a persisted conversation message (GET /api/sessions/:id) —
// structurally matches OpenAI's ChatCompletionMessageParam but declared here
// standalone so this package doesn't need the `openai` dependency.
export type StoredMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

// Wire shape of one row from GET /api/sessions.
export type SessionSummary = { id: string; updatedAt: string; preview: string | null }
