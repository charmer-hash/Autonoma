import { bigint, bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type OpenAI from 'openai'

export const users = pgTable('users', {
  id: text('id').primaryKey(), // crypto.randomUUID()，由 scripts/create-user.ts 生成
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
})

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(), // 插入顺序 == 对话顺序
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  // 原样存储，以便能精确地还原回 OpenAI 的 messages
  // 数组 —— 不按角色拆分列，联合类型本身已经定义了结构。
  message: jsonb('message').$type<OpenAI.Chat.ChatCompletionMessageParam>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

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
})
