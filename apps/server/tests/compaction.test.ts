import assert from 'node:assert/strict'
import test from 'node:test'

process.env.OPENROUTER_API_KEY = 'test-placeholder'

const { client } = await import('../src/agent/client.js')
const { compactToolResultsForModel, summarizeFoldInBatches } = await import('../src/agent/compaction.js')

test('model tool-result compaction preserves tool messages and truncates only the model copy', () => {
  const messages = [
    { role: 'assistant' as const, content: null, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'web_fetch', arguments: '{}' } }] },
    { role: 'tool' as const, tool_call_id: 'call-1', content: 'head-' + 'x'.repeat(500) + '-tail' },
  ]
  const original = messages[1].content

  assert.equal(compactToolResultsForModel(messages, 80), true)
  assert.equal(messages[0].role, 'assistant')
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[1].tool_call_id, 'call-1')
  assert.ok(messages[1].content.includes('工具结果已截断'))
  assert.ok(messages[1].content.startsWith('head-'))
  assert.ok(messages[1].content.endsWith('-tail'))
  assert.equal(original.length > messages[1].content.length, true)
})

test('summary compaction uses one model call when the full fold fits the summary context', async () => {
  const original = client.chat.completions.create
  let calls = 0
  client.chat.completions.create = (async () => {
    calls++
    return { choices: [{ message: { content: '用户多次询问上下文压缩，并希望减少模型调用次数。' } }] }
  }) as unknown as typeof original

  try {
    const summary = await summarizeFoldInBatches(null, [
      { role: 'user', content: '第一轮：分析上下文压缩。' },
      { role: 'assistant', content: '已分析。' },
      { role: 'user', content: '第二轮：希望压缩更快。' },
      { role: 'assistant', content: '建议使用更快模型。' },
    ])
    assert.equal(calls, 1)
    assert.equal(summary, '用户多次询问上下文压缩，并希望减少模型调用次数。')
  } finally {
    client.chat.completions.create = original
  }
})
