import assert from 'node:assert/strict'
import test from 'node:test'

// No real model, database, or sandbox calls are needed for this regression test.
process.env.OPENROUTER_API_KEY = 'test-placeholder'
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test'
const { client } = await import('../src/agent/client.js')
const { runAgentLoop } = await import('../src/agent/loop.js')

test('a streamed chat reply completes with sandbox tools enabled but no sandbox access', async () => {
  const original = client.chat.completions.create
  client.chat.completions.create = (async () => (async function* () {
    yield { choices: [{ delta: { content: '你好' } }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  })()) as unknown as typeof original
  try {
    const events = []
    let sandboxCalls = 0
    for await (const event of runAgentLoop(
      [{ role: 'system', content: 'Assistant' }, { role: 'user', content: '你好' }],
      async () => { sandboxCalls++; throw new Error('unexpected sandbox access') },
      'test-session',
    )) events.push(event)
    assert.deepEqual(events, [{ type: 'text_delta', delta: '你好' }, { type: 'done' }])
    assert.equal(sandboxCalls, 0)
  } finally {
    client.chat.completions.create = original
  }
})
