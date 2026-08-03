export type MessageAttachment = { filename: string; mimeType: string; size: number }

export type Block =
  // attachments is only ever populated for the live-just-sent bubble (see
  // useConsoleSession's run()) — a reloaded/historical session has no way to
  // recover it, since the persisted message content only carries a plain-text
  // note about the upload, not structured data. See apps/server/src/index.ts's
  // attachFilesToSandbox.
  | { kind: 'user'; text: string; attachments?: MessageAttachment[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: string; status: 'running' | 'done' }
  | { kind: 'document'; name: string; content: string }
  | { kind: 'artifact'; id: string; name: string; mimeType: string; size: number }
  | { kind: 'error'; text: string }

export type Group =
  | { role: 'user'; text: string; attachments?: MessageAttachment[] }
  | { role: 'assistant'; blocks: Exclude<Block, { kind: 'user' }>[] }
