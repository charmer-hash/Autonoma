import { bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
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
