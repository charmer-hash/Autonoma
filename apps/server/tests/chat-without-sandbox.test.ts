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

test('web_search preserves the returned result content', async () => {
  const originalKey = process.env.TAVILY_API_KEY
  const originalFetch = globalThis.fetch
  process.env.TAVILY_API_KEY = 'test-key'
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [
      { title: 'Alpha', url: 'https://example.com/a', content: 'A'.repeat(800) },
      { title: 'Beta', url: 'https://example.com/b', content: 'B'.repeat(600) },
      { title: 'Gamma', url: 'https://example.com/c', content: 'C'.repeat(500) },
    ],
  }), { status: 200 }) as typeof fetch

  try {
    const { searchToolHandlers } = await import('../src/agent/tools/search.js')
    const result = JSON.parse(await searchToolHandlers.web_search({ query: 'example' }))
    assert.equal(result.results.length, 3)
    assert.equal(result.results[0].snippet.length, 800)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = originalKey
  }
})
