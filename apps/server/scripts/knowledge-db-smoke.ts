// Run explicitly with AUTH_SESSION_SECRET empty and the server .env loaded.
// Exercises real Postgres retrieval and the required-mode no-hit path with either a valid or failed embedding service.
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { app } from '../src/index.js'
import { db, pool } from '../src/db/client.js'
import { knowledgeBases, knowledgeChunks, knowledgeDocuments } from '../src/db/schema.js'
import { searchKnowledge } from '../src/knowledge/search.js'

if (process.env.AUTH_SESSION_SECRET) throw new Error('仅允许在独立匿名测试进程运行。')
const baseId = crypto.randomUUID()
const documentId = crypto.randomUUID()
const phrase = `验证词-${crypto.randomUUID()}`
let sessionId: string | undefined
try {
  await db.insert(knowledgeBases).values({ id: baseId, ownerId: null, name: `smoke-${baseId}` })
  await db.insert(knowledgeDocuments).values({
    id: documentId, knowledgeBaseId: baseId, filename: 'smoke.txt', mimeType: 'text/plain',
    sizeBytes: phrase.length, sha256: 'smoke', currentVersion: 1, status: 'ready', chunkCount: 1,
  })
  await db.insert(knowledgeChunks).values({
    documentId, documentVersion: 1, ordinal: 0, pageNumber: null, headingPath: null,
    startOffset: 0, endOffset: phrase.length, content: `只用于自动测试。${phrase}`,
    embedding: Array.from({ length: 1024 }, () => 0.1),
  })
  const hit = await searchKnowledge(undefined, { query: phrase, knowledgeBaseIds: [baseId] })
  assert.ok(hit.status === 'ok' || hit.status === 'degraded')
  assert.equal(hit.sources[0]?.documentId, documentId)
  console.log(`Postgres retrieval: hit (${hit.status})`)

  const response = await app.request('/api/agent/run', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
  }, body: JSON.stringify({ task: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', knowledgeMode: 'required', knowledgeBaseIds: [baseId] }) })
  assert.equal(response.status, 200)
  const stream = await response.text()
  const events = stream.split('\n').filter((line) => line.startsWith('data: ')).map((line) => {
    try { return JSON.parse(line.slice(6)) as { type: string; sessionId?: string; result?: string; delta?: string } }
    catch { return null }
  }).filter((event) => event !== null)
  sessionId = events.find((event) => event.type === 'session')?.sessionId
  assert.ok(events.some((event) => event.type === 'tool_result'), 'required search result missing')
  assert.ok(events.some((event) => event.type === 'text_delta' && /无法.*依据知识库回答/.test(event.delta ?? '')))
  assert.ok(events.some((event) => event.type === 'done'))
  console.log('Agent required no-hit path: completed without model call')
} finally {
  if (sessionId) await pool.query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch((err) => console.error('session cleanup failed:', err))
  await db.delete(knowledgeBases).where(eq(knowledgeBases.id, baseId)).catch((err) => console.error('base cleanup failed:', err))
  await pool.end()
}
