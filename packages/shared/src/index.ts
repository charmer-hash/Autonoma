// Event shape streamed from apps/server's agent loop over SSE and consumed
// by apps/web. Kept as a type-only export — erased at compile time, no
// runtime dependency between the two apps.
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'document'; name: string; content: string }
  | { type: 'artifact'; id: string; name: string; mimeType: string; size: number }
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

// Request/response shape for minting a direct-to-R2 upload slot. Not tied to
// a specific endpoint yet — apps/server doesn't expose one today (only the
// artifact download side, see lib/storage.ts's getPresignedDownloadUrl) —
// but the frontend upload adapter (@autonoma/upload/lib/upload) is built against
// this shape now so the two sides stay in sync whenever that endpoint lands.
export type PresignedUploadRequest = { filename: string; mimeType: string; size: number }
export type PresignedUpload = { url: string; key: string }

// Wire shapes for R2's multipart upload flow (large files split into parts,
// each PUT to its own presigned URL) — used by @autonoma/upload/lib/multipart.
// Three round-trips bracket the direct-to-R2 part PUTs: create (mint an
// uploadId), getPartUrl (once per part), complete (hand back each part's
// ETag so R2 can assemble the object). Same division of labor as
// PresignedUpload above — only URL minting touches the server, never bytes.
export type MultipartCreateRequest = { filename: string; mimeType: string; size: number }
export type MultipartCreateResponse = { key: string; uploadId: string }
export type MultipartPartUrlRequest = { key: string; uploadId: string; partNumber: number }
export type MultipartPart = { partNumber: number; etag: string }
export type MultipartCompleteRequest = { key: string; uploadId: string; parts: MultipartPart[] }
export type MultipartAbortRequest = { key: string; uploadId: string }

// A finished upload the client hands to POST /api/agent/run so the server
// can pull it out of R2 and into the sandbox before the agent starts — see
// apps/server/src/index.ts. filename/mimeType/size are echoed back from the
// upload (not re-derived from the R2 object) since the server needs them
// before it ever touches the object itself.
export type UploadedAttachment = { key: string; filename: string; mimeType: string; size: number }
