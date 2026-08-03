import { bigint, bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type OpenAI from 'openai'

export const users = pgTable('users', {
  id: text('id').primaryKey(), // crypto.randomUUID(), minted by scripts/create-user.ts
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // server-issued sessionId (crypto.randomUUID() in index.ts)
  // The user that created this session — null when auth is off, or the user
  // was later deleted. Null means "anyone can access it" (see
  // resolveSessionAccess in db/sessions.ts).
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Rolling summary of history folded out of the raw send-to-model tail —
  // see agent/compaction.ts. Null means nothing has been folded yet.
  // Original message rows are never deleted; this only changes what
  // loadSessionMessagesForAgent sends to the LLM, not what's stored.
  summary: text('summary'),
  // Last messages.id folded into `summary` (no FK to messages — rows there
  // are append-only and never deleted, so there's nothing to dangle).
  summarizedThroughId: bigint('summarized_through_id', { mode: 'number' }),
  // e2b sandbox id this session's agent runs currently reuse (see
  // index.ts's /api/agent/run) — null means no live sandbox to reconnect to
  // (brand new session, or its sandbox already expired). Not a foreign key,
  // just an opaque string e2b itself owns the lifecycle of.
  sandboxId: text('sandbox_id'),
})

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(), // insertion order == conversation order
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  // Stored verbatim so it round-trips exactly back into the OpenAI messages
  // array — no per-role column split, the union type already defines the shape.
  message: jsonb('message').$type<OpenAI.Chat.ChatCompletionMessageParam>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Metadata for a file the agent exported from its sandbox (export_artifact
// tool) — the file bytes themselves live in R2 (see lib/storage.ts), keyed
// by r2Key. No ownerId column: access is gated via sessionId -> sessions
// ownership, same as `messages`, not a second permission model. Not linked
// to a specific tool_call row: the persisted tool result message already
// carries this row's id/name/mimeType/size verbatim (see
// apps/web/src/lib/blocks.ts), so the frontend never needs to query this
// table by tool_call id — only GET /api/artifacts/:id (by this row's own id)
// does, to resolve a download.
export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(), // crypto.randomUUID(), minted by the export_artifact tool handler
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  r2Key: text('r2_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
