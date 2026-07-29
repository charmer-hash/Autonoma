export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: unknown; result?: string; status: 'running' | 'done' }
  | { kind: 'document'; name: string; content: string }
  | { kind: 'error'; text: string }

export type Group =
  | { role: 'user'; text: string }
  | { role: 'assistant'; blocks: Exclude<Block, { kind: 'user' }>[] }
