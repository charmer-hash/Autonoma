import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core'
import type OpenAI from 'openai'

export const users = pgTable('users', {
  id: text('id').primaryKey(), // crypto.randomUUID()，由 scripts/create-user.ts 生成
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Agent 处理该用户所有对话时都会参考的自定义指令（Agent 设置里填写）。
  // null 表示用户从未设置过，读取时统一按空字符串处理 —— 参见
  // db/users.ts 的 getAgentSettings。这里用 text 不限长度，长度上限
  // 只在 API 层校验（见 index.ts），避免数据库层的硬约束把体验做成
  // "提交后才报错"。
  customInstructions: text('custom_instructions'),
  // 以下 8 列都是 Agent 设置弹窗里新增的项，全部 notNull + 数据库侧默认值，
  // 这样历史行读出来就直接是"当前行为不变"的默认值，不需要回填脚本。
  // 取值范围（'auto'|'confirm'、5-60 等）只在 API 层校验，见 index.ts。
  approvalMode: text('approval_mode').notNull().default('auto'), // 'auto' | 'confirm'
  maxTurns: integer('max_turns').notNull().default(30),
  codeExecEnabled: boolean('code_exec_enabled').notNull().default(true),
  webSearchEnabled: boolean('web_search_enabled').notNull().default(true),
  visionEnabled: boolean('vision_enabled').notNull().default(true),
  modelChoice: text('model_choice').notNull().default('default'), // 'default' | 'grok'
  conciseReplies: boolean('concise_replies').notNull().default(false),
  sandboxIdleMinutes: integer('sandbox_idle_minutes').notNull().default(10),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // 由服务端生成的 sessionId（在 index.ts 中通过 crypto.randomUUID() 生成）
  // 创建此会话的用户 —— 当鉴权关闭时，或该用户后来被删除时为 null。
  // null 意味着"任何人都可以访问它"（参见 db/sessions.ts 中的
  // resolveSessionAccess）。
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // 从原始发送给模型的消息尾部折叠出来的滚动历史摘要 ——
  // 参见 agent/compaction.ts。null 表示尚未发生任何折叠。
  // 原始消息行永远不会被删除；这只会改变
  // loadSessionMessagesForAgent 发送给 LLM 的内容，而不改变实际存储的内容。
  summary: text('summary'),
  // 最后一条被折叠进 `summary` 的 messages.id（不设置到 messages 的外键 ——
  // 那里的行只增不删，因此不存在悬空引用的问题）。
  summarizedThroughId: bigint('summarized_through_id', { mode: 'number' }),
  // 此会话的 agent 运行当前复用的 e2b 沙箱 id（参见
  // index.ts 中的 /api/agent/run）—— null 表示没有可重连的存活沙箱
  // （全新会话，或其沙箱已过期）。不是外键，
  // 只是一个由 e2b 自身管理生命周期的不透明字符串。
  sandboxId: text('sandbox_id'),
}, (table) => ([
  // listSessions 按 ownerId 过滤、按 updatedAt 排序 —— 见 db/sessions.ts。
  index('sessions_owner_id_idx').on(table.ownerId),
]))

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(), // 插入顺序 == 对话顺序
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  // 原样存储，以便能精确地还原回 OpenAI 的 messages
  // 数组 —— 不按角色拆分列，联合类型本身已经定义了结构。
  message: jsonb('message').$type<OpenAI.Chat.ChatCompletionMessageParam>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  // Postgres 不会为外键列自动建索引 —— loadMessageRows/listSessions 里的相关
  // 子查询都按 session_id 过滤，见 db/sessions.ts。
  index('messages_session_id_idx').on(table.sessionId),
]))

// agent 从其沙箱导出的文件（export_artifact 工具）的元数据 ——
// 文件字节本身存放在 R2（参见 lib/storage.ts），以 r2Key 为键。
// 没有 ownerId 列：访问权限通过 sessionId -> sessions 的所有权来控制，
// 和 `messages` 一样，而不是第二套权限模型。不与某个具体的
// tool_call 行关联：持久化的工具结果消息中已经原样携带了
// 这一行的 id/name/mimeType/size（参见
// apps/web/src/lib/blocks.ts），所以前端从来不需要通过 tool_call id
// 来查询这张表 —— 只有 GET /api/artifacts/:id（按这一行自身的 id）
// 会这么做，用来解析下载地址。
export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(), // crypto.randomUUID()，由 export_artifact 工具处理函数生成
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  r2Key: text('r2_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  index('artifacts_session_id_idx').on(table.sessionId),
]))

// 用户上传、Agent 消费的输入文件元数据——跟 artifacts 方向相反
// （那张表是 Agent 生成给用户下载的产物），但存储模式一样：字节在
// R2（uploads/ 目录，attachFilesToSandbox 写入沙箱时用的同一个
// key），数据库只存小引用。这个 key 是永久有效的，不随沙箱过期而
// 失效，所以当沙箱里的文件因为过期已经找不到时（参见
// agent/tools/vision.ts 的 view_image），还能凭这条记录回 R2 把原始
// 文件重新取回来。filename 存的是 attachFilesToSandbox 里算出来的
// 沙箱内文件名，用于按名字反查。
export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(), // crypto.randomUUID()
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  r2Key: text('r2_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  // getAttachmentByFilename 按 (sessionId, filename) 查找 —— 见 db/attachments.ts。
  index('attachments_session_id_filename_idx').on(table.sessionId, table.filename),
]))

// 每次大模型调用（loop.ts 里 client.chat.completions.create 每被调一次）
// 落一条，用真实花费（OpenRouter 返回的 usage.cost，不是估算的 token
// 数）做每日额度控制——见 index.ts 的 /api/agent/run。ownerId 为 null
// 表示鉴权关闭时产生的调用（本地开发场景），这类记录只用于留痕，不参与
// 额度计算（db/usage.ts 的 getDailyCostUsd 只在 ownerId 存在时才查询）。
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull(),
  completionTokens: integer('completion_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  // getDailyCostUsd 按 (ownerId, createdAt) 查最近 24 小时花费总和。
  index('usage_events_owner_id_created_at_idx').on(table.ownerId, table.createdAt),
]))
