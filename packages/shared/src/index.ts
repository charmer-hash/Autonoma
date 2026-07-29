// Event shape streamed from apps/server's agent loop over SSE and consumed
// by apps/web. Kept as a type-only export — erased at compile time, no
// runtime dependency between the two apps.
export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'document'; name: string; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
