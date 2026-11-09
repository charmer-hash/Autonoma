import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test'
process.env.OPENROUTER_API_KEY = 'test-key'
const { pool } = await import('../src/db/client.js')
const { searchKnowledge } = await import('../src/knowledge/search.js')

type Row = { chunk_id: string; document_id: string; filename: string; page_number: number; heading_path: string; content: string }
const row = (id: string, document = 'doc-1'): Row => ({
  chunk_id: id, document_id: document, filename: 'handbook.md', page_number: 2,
  heading_path: 'Policy', content: `evidence ${id}`,
})

test('hybrid retrieval fuses ranks, deduplicates chunks and caps one document', async () => {
  const originalQuery = pool.query
  const originalFetch = globalThis.fetch
  try {
    pool.query = (async (sql: string, params: unknown[]) => {
      assert.match(sql, /owner_id IS NOT DISTINCT FROM/)
      assert.equal(params[0], 'owner-1')
      if (sql.includes('embedding <=>')) {
        assert.match(sql, /embedding <=> \$4::vector/)
        assert.equal(params.length, 5)
        assert.equal(params[4], 0.5)
      }
      return { rows: sql.includes('embedding <=>') ? [row('a'), row('b'), row('c'), row('d')] : [row('b'), row('a'), row('e', 'doc-2')] }
    }) as typeof pool.query
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
      index: 0, embedding: Array.from({ length: 1024 }, () => 0.1),
    }] }), { status: 200 })
    const result = await searchKnowledge('owner-1', { query: 'policy', limit: 8 })
    assert.equal(result.status, 'ok')
    assert.equal(result.sources.length, 4)
    assert.equal(result.sources.filter((source) => source.documentId === 'doc-1').length, 3)
    assert.equal(result.sources[0].chunkId, 'a')
    assert.equal(result.sources[1].chunkId, 'b')
    assert.deepEqual(result.sources.map((source) => source.ref), ['K1', 'K2', 'K3', 'K4'])
  } finally {
    pool.query = originalQuery
    globalThis.fetch = originalFetch
  }
})

test('vector failure degrades to keyword results and reports the failure', async () => {
  const originalQuery = pool.query
  const originalFetch = globalThis.fetch
  try {
    pool.query = (async () => ({ rows: [row('keyword')] })) as typeof pool.query
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })
    const result = await searchKnowledge(undefined, { query: 'policy' })
    assert.equal(result.status, 'degraded')
    assert.equal(result.sources[0].chunkId, 'keyword')
    assert.match(result.warning ?? '', /向量检索不可用/)
  } finally {
    pool.query = originalQuery
    globalThis.fetch = originalFetch
  }
})

test('weak vector-only cross-document hit is excluded', async () => {
  const originalQuery = pool.query
  const originalFetch = globalThis.fetch
  try {
    pool.query = (async (sql: string) => ({ rows: sql.includes('embedding <=>')
      ? [{ ...row('playlist'), vector_similarity: 0.65 }, { ...row('seo', 'doc-seo'), vector_similarity: 0.53 }]
      : [row('playlist')] })) as typeof pool.query
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
      index: 0, embedding: Array.from({ length: 1024 }, () => 0.1),
    }] }), { status: 200 })
    const result = await searchKnowledge(undefined, { query: '如何验收' })
    assert.deepEqual(result.sources.map((source) => source.chunkId), ['playlist'])
  } finally {
    pool.query = originalQuery
    globalThis.fetch = originalFetch
  }
})

test('a matching section heading outranks generic chunks for a section-specific question', async () => {
  const originalQuery = pool.query
  const originalFetch = globalThis.fetch
  try {
    const steps = { ...row('steps'), heading_path: '验收步骤' }
    pool.query = (async (sql: string) => ({ rows: sql.includes('embedding <=>')
      ? [row('intro'), steps, row('other')]
      : [row('intro'), row('other'), steps] })) as typeof pool.query
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
      index: 0, embedding: Array.from({ length: 1024 }, () => 0.1),
    }] }), { status: 200 })
    const result = await searchKnowledge(undefined, { query: '如何验收' })
    assert.equal(result.sources[0].chunkId, 'steps')
  } finally {
    pool.query = originalQuery
    globalThis.fetch = originalFetch
  }
})

test('scope arguments are validated before any database access', async () => {
  await assert.rejects(() => searchKnowledge(undefined, { query: 'x', knowledgeBaseIds: [''] }), /范围无效/)
  await assert.rejects(() => searchKnowledge(undefined, { query: 'x', limit: 9 }), /返回数量/)
})
