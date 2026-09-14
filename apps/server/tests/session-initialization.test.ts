import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

process.env.OPENROUTER_API_KEY = 'test-placeholder'
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test'
const { db } = await import('../src/db/client.js')
const { initializeSessionForAgent } = await import('../src/db/sessions.js')

test('new session initialization uses one atomic parameterized write without history reads', async () => {
  const original = db.execute
  const queries: { sql: string; params: unknown[] }[] = []
  db.execute = (async (query: Parameters<typeof db.execute>[0]) => {
    assert.equal(typeof query, 'object')
    const compiled = new PgDialect().sqlToQuery((query as { getSQL(): import('drizzle-orm').SQL }).getSQL())
    queries.push(compiled)
    return { rows: [], rowCount: 1 }
  }) as unknown as typeof original
  try {
    const messages = await initializeSessionForAgent('new-session', 'owner')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'system')
    assert.equal(queries.length, 1)
    assert.match(queries[0].sql, /with created as/)
    assert.match(queries[0].sql, /on conflict \(id\) do nothing/)
    assert.match(queries[0].sql, /insert into messages/)
    assert.doesNotMatch(queries[0].sql, /from (sessions|messages)/)
    assert.deepEqual(queries[0].params, ['new-session', 'owner', JSON.stringify(messages[0])])
  } finally {
    db.execute = original
  }
})
