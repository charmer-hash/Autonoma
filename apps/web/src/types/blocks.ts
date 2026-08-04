// mimeType/size/previewUrl 只有刚发送出去的实时气泡才有（来自浏览器
// File 对象，见 Composer.tsx——previewUrl 是 URL.createObjectURL(file)，
// 图片能立刻本地预览，不用等服务端把附件记录落库）；重新加载的/历史
// 会话是从持久化消息里那段纯文本提示解析文件名反查出来的（见
// apps/web/src/lib/blocks.ts），这几个字段都拿不到，所以是可选的——
// 历史消息的缩略图改走 GET /api/sessions/:sessionId/attachments/:filename
// （见 MessageList.tsx 的 AttachmentChip）。
export type MessageAttachment = { filename: string; mimeType?: string; size?: number; previewUrl?: string }

// Composer 发送时构造的附件——比线上协议用的 UploadedAttachment 多一个
// 仅存在于浏览器里的 previewUrl（blob: URL），发请求给 /api/agent/run
// 之前会被剥掉，只用来让 consoleStore 往 blocks 里塞的这一条本地
// 消息能立刻显示缩略图。
export type SentAttachment = { key: string; filename: string; mimeType: string; size: number; previewUrl?: string }

export type Block =
  | { kind: 'user'; text: string; attachments?: MessageAttachment[] }
  | { kind: 'text'; text: string }
  // 'awaiting_approval'：审批模式下工具真正执行前推给用户确认的状态，
  // 见 ToolCard.tsx——点批准后由服务端推来的 tool_call 事件转成 'running'，
  // 点拒绝/超时后服务端直接推 tool_result，转成 'done'。
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: string; status: 'running' | 'done' | 'awaiting_approval' }
  | { kind: 'document'; name: string; content: string }
  | { kind: 'artifact'; id: string; name: string; mimeType: string; size: number }
  | { kind: 'error'; text: string }

export type Group =
  | { role: 'user'; text: string; attachments?: MessageAttachment[] }
  | { role: 'assistant'; blocks: Exclude<Block, { kind: 'user' }>[] }
