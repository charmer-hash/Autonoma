// 由 apps/server 的 agent 循环通过 SSE 流式发送、并由 apps/web 消费的事件结构。
// 这里将其保留为纯类型导出 —— 编译时会被擦除，两个应用之间不存在运行时依赖。
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  // 审批模式（AgentSettings.approvalMode === 'confirm'）下，run_command/write_file/
  // export_artifact 这几个会改动沙箱状态的工具在真正执行前先发出这个事件，等待
  // 用户在前端点击批准/拒绝（POST /api/agent/approve）——参见 agent/approvals.ts。
  | { type: 'approval_required'; id: string; name: string; args: unknown }
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

// GET /api/auth/me 的线上传输结构 —— username 只在已登录且鉴权开启时
// 才有值（本地免登录模式下 authenticated 恒为 true 但没有具体账号）。
export type AuthMeResponse = { authenticated: boolean; username?: string }

// GET /api/auth/public-key 的线上传输结构——publicKey 是 RSA 公钥的
// SPKI/DER 编码，再转成 base64（不是 PEM，前端直接用 Web Crypto 的
// `importKey('spki', ...)` 消费，不需要额外解析 PEM 头尾）。参见
// apps/server/src/lib/login-crypto.ts。
export type PublicKeyResponse = { publicKey: string }

// POST /api/auth/login 的线上传输结构——密码字段永远是用上面这把
// RSA 公钥加密后的密文（base64），服务端用私钥解密后才会拿去跟数据库里
// 的 scrypt 哈希比对；请求体里不会出现明文密码。
export type LoginRequest = { username: string; encryptedPassword: string }

// Agent 设置（GET/PUT /api/settings）的线上传输结构 —— 自定义指令 +
// 审批模式/最大步数/工具开关/模型选择/回复风格/沙箱空闲时长。
// MAX_CUSTOM_INSTRUCTIONS_LENGTH 同时被 apps/server 的 API 校验和
// apps/web 的 Textarea maxLength 使用，跟这段文本会在用户每次对话时
// 都被拼进发给模型的消息有关 —— 定得太宽会让每轮请求都多带一大截
// 可有可无的 token。
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 2000

export type ApprovalMode = 'auto' | 'confirm'
export type ModelChoice = 'default' | 'grok'

export const MIN_MAX_TURNS = 5
export const MAX_MAX_TURNS = 60
export const MIN_SANDBOX_IDLE_MINUTES = 5
export const MAX_SANDBOX_IDLE_MINUTES = 60

// 模型选择只开放这两档 —— 这个 OpenRouter 账号目前只验证过
// deepseek-v4-pro/grok-4.5/glm-4.6v/qwen3-vl 能正常调用（其余模型可能
// 直接 403，见 agent/client.ts），开放更多档位风险自担。
export const MODEL_CHOICES: { value: ModelChoice; label: string; description: string }[] = [
  { value: 'default', label: '默认', description: '速度快、成本低，适合大多数任务' },
  { value: 'grok', label: 'Grok 4.5（推理更强）', description: '推理能力更强，速度较慢、成本更高' },
]

export type AgentSettings = {
  customInstructions: string
  approvalMode: ApprovalMode
  maxTurns: number
  codeExecEnabled: boolean
  webSearchEnabled: boolean
  visionEnabled: boolean
  modelChoice: ModelChoice
  conciseReplies: boolean
  sandboxIdleMinutes: number
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  customInstructions: '',
  approvalMode: 'auto',
  maxTurns: 30,
  codeExecEnabled: true,
  webSearchEnabled: true,
  visionEnabled: true,
  modelChoice: 'default',
  conciseReplies: false,
  sandboxIdleMinutes: 10,
}

export type AgentSettingsResponse = AgentSettings
export type UpdateAgentSettingsRequest = AgentSettings
export type UpdateAgentSettingsResponse = { ok: true; persisted: boolean }
