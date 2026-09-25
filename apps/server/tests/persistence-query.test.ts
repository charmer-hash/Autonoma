import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

process.env.OPENROUTER_API_KEY = 'test-placeholder'
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test'
const { db } = await import('../src/db/client.js')
const { appendMessages, listSessions } = await import('../src/db/sessions.js')

test('conversation persistence inserts messages and updates recency in one parameterized query', async () => {
  const original = db.execute
  const queries: { sql: string; params: unknown[] }[] = []
  db.execute = (async (query: Parameters<typeof db.execute>[0]) => {
    const compiled = new PgDialect().sqlToQuery((query as { getSQL(): import('drizzle-orm').SQL }).getSQL())
    queries.push(compiled)
    return { rows: [], rowCount: 1 }
  }) as unknown as typeof original

  try {
    await appendMessages('session-1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
    assert.equal(queries.length, 1)
    assert.match(queries[0].sql, /jsonb_array_elements/)
    assert.match(queries[0].sql, /update sessions/i)
    assert.deepEqual(queries[0].params, [
      'session-1',
      JSON.stringify([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }]),
      'session-1',
    ])
  } finally {
    db.execute = original
  }
})

test('session search only computes returned previews and matches the first user message', async () => {
  const original = db.execute
  let query: { sql: string; params: unknown[] } | undefined
  db.execute = (async (statement: Parameters<typeof db.execute>[0]) => {
    query = new PgDialect().sqlToQuery((statement as { getSQL(): import('drizzle-orm').SQL }).getSQL())
    return { rows: [], rowCount: 0 }
  }) as unknown as typeof original

  try {
    await listSessions('owner-1', { limit: 20, offset: 0, search: 'needle' })
    assert.ok(query)
    assert.match(query.sql, /preview_matches as materialized/i)
    assert.match(query.sql, /msg\.message->>'role' = 'user'/)
    assert.match(query.sql, /join sessions s on s\.id = m\.id/i)
    assert.deepEqual(query.params, ['owner-1', '%needle%', 21, 'owner-1', '%needle%', 21, 21, 0])
  } finally {
    db.execute = original
  }
})
