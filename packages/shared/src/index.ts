// 由 apps/server 的 agent 循环通过 SSE 流式发送、并由 apps/web 消费的事件结构。
// 这里将其保留为纯类型导出 —— 编译时会被擦除，两个应用之间不存在运行时依赖。
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'document'; name: string; content: string }
  | { type: 'artifact'; id: string; name: string; mimeType: string; size: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

// 持久化会话消息（GET /api/sessions/:id）的线上传输结构 ——
// 结构上与 OpenAI 的 ChatCompletionMessageParam 一致，但在此单独声明，
// 这样本包就不需要依赖 `openai`。
export type StoredMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

// GET /api/sessions 返回的单行数据的线上传输结构。
export type SessionSummary = { id: string; updatedAt: string; preview: string | null }

// 生成直传 R2 的上传槽位所用的请求/响应结构。目前还没有绑定到具体的
// 端点 —— apps/server 目前只暴露了 artifact 下载那一侧（参见 lib/storage.ts
// 中的 getPresignedDownloadUrl），但前端的上传适配器（@autonoma/upload/lib/upload）
// 已经按这个结构实现了，这样等对应的端点上线时两边能保持一致。
export type PresignedUploadRequest = { filename: string; mimeType: string; size: number }
export type PresignedUpload = { url: string; key: string }

// R2 分片上传流程（大文件被拆分成若干部分，每部分各自 PUT 到自己的预签名
// URL）所用的线上传输结构 —— 由 @autonoma/upload/lib/multipart 使用。
// 直传 R2 的分片 PUT 请求前后由三次往返包裹：create（生成一个 uploadId）、
// getPartUrl（每个分片调用一次）、complete（把每个分片的 ETag 回传，
// 让 R2 能拼装出完整对象）。分工方式与上面的 PresignedUpload 相同 ——
// 只有 URL 的生成会经过服务端，字节数据本身从不经过服务端。
export type MultipartCreateRequest = { filename: string; mimeType: string; size: number }
export type MultipartCreateResponse = { key: string; uploadId: string }
export type MultipartPartUrlRequest = { key: string; uploadId: string; partNumber: number }
export type MultipartPart = { partNumber: number; etag: string }
export type MultipartCompleteRequest = { key: string; uploadId: string; parts: MultipartPart[] }
export type MultipartAbortRequest = { key: string; uploadId: string }

// 客户端在调用 POST /api/agent/run 时传给服务端的一个已完成上传，服务端
// 会据此在 agent 启动前把对象从 R2 拉取到沙箱中 —— 参见
// apps/server/src/index.ts。filename/mimeType/size 是从上传过程中原样
// 回传的（而不是从 R2 对象重新解析出来的），因为服务端在真正接触到该
// 对象之前就需要用到这些信息。
export type UploadedAttachment = { key: string; filename: string; mimeType: string; size: number }
