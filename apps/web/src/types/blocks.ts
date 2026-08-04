export type MessageAttachment = { filename: string; mimeType: string; size: number }

export type Block =
  // attachments 只会在刚发送出去的实时气泡中被填充（见 useConsoleSession
  // 的 run()）——重新加载的/历史会话无法恢复它，因为持久化的消息内容
  // 只携带一段关于上传的纯文本说明，而非结构化数据。参见
  // apps/server/src/index.ts 的 attachFilesToSandbox。
  | { kind: 'user'; text: string; attachments?: MessageAttachment[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: string; status: 'running' | 'done' }
  | { kind: 'document'; name: string; content: string }
  | { kind: 'artifact'; id: string; name: string; mimeType: string; size: number }
  | { kind: 'error'; text: string }

export type Group =
  | { role: 'user'; text: string; attachments?: MessageAttachment[] }
  | { role: 'assistant'; blocks: Exclude<Block, { kind: 'user' }>[] }
