// Run explicitly with: node --env-file=.env --import tsx scripts/knowledge-smoke.ts
// Uses a uniquely named temporary knowledge base, then removes its database and R2 objects.
import assert from 'node:assert/strict'
import { app } from '../src/index.js'
import { pool } from '../src/db/client.js'
import { startKnowledgeWorker } from '../src/knowledge/worker.js'
import { deleteObject } from '../src/lib/storage.js'

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
const baseName = `knowledge-smoke-${crypto.randomUUID()}`
const fact = `项目验收代号是蓝鲸-${crypto.randomUUID().slice(0, 8)}`
let baseId: string | undefined
let uploadKey: string | undefined
let replacementUploadKey: string | undefined
let sessionId: string | undefined
let stopWorker: (() => Promise<void>) | undefined

async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const payload = await response.json() as T & { error?: string }
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${payload.error ?? ''}`)
  return payload
}

try {
  // Smoke testing runs in its own process, with auth switched off before app imports.
  // The environment must not point to a shared public server.
  if (process.env.AUTH_SESSION_SECRET) throw new Error('请在独立测试环境运行：当前配置启用了认证，不能使用匿名烟雾测试。')
  const { base } = await json<{ base: { id: string } }>('/api/knowledge/bases', 'POST', { name: baseName })
  baseId = base.id
  console.log('knowledge base: created')

  const content = new TextEncoder().encode(`# 验收说明\n\n${fact}。这是知识库上传、切片、向量检索和 Agent 引用的测试资料。`)
  const { url, key } = await json<{ url: string; key: string }>('/api/uploads', 'POST', {
    filename: 'knowledge-smoke.md', mimeType: 'text/markdown', size: content.length,
  })
  uploadKey = key
  const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: content })
  assert.ok(put.ok, `R2 PUT: HTTP ${put.status}`)
  console.log('R2 upload: ok')

  const { id: documentId } = await json<{ id: string }>(`/api/knowledge/bases/${baseId}/documents`, 'POST', {
    key, filename: 'knowledge-smoke.md', mimeType: 'text/markdown',
  })
  stopWorker = startKnowledgeWorker()
  let status = ''
  for (let attempt = 0; attempt < 40; attempt++) {
    const { documents } = await json<{ documents: { id: string; status: string; errorMessage: string | null; chunkCount: number }[] }>(`/api/knowledge/bases/${baseId}/documents`)
    const doc = documents.find((item) => item.id === documentId)
    assert.ok(doc)
    status = doc.status
    if (doc.errorMessage) throw new Error(`indexing failed: ${doc.errorMessage}`)
    if (status === 'ready') { assert.ok(doc.chunkCount > 0); break }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  assert.equal(status, 'ready', 'indexing timed out')
  console.log('indexing: ready')

  const search = await json<{ status: string; sources: { content: string; documentId: string }[] }>(`/api/knowledge/bases/${baseId}/search`, 'POST', { query: fact })
  assert.equal(search.status, 'ok', 'hybrid retrieval degraded')
  assert.ok(search.sources.some((source) => source.documentId === documentId && source.content.includes(fact)), 'search did not recall test fact')
  console.log('hybrid search: hit')

  let expectedFact = fact
  if (process.argv.includes('--replace')) {
    expectedFact = `新版验收代号是海豚-${crypto.randomUUID().slice(0, 8)}`
    const updated = new TextEncoder().encode(`# 新版说明\n\n${expectedFact}。旧版内容已被替换。`)
    const replacement = await json<{ url: string; key: string }>('/api/uploads', 'POST', {
      filename: 'knowledge-smoke-v2.md', mimeType: 'text/markdown', size: updated.length,
    })
    replacementUploadKey = replacement.key
    const uploaded = await fetch(replacement.url, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: updated })
    assert.ok(uploaded.ok, `replacement R2 PUT: HTTP ${uploaded.status}`)
    await json(`/api/knowledge/documents/${documentId}`, 'PUT', {
      key: replacement.key, filename: 'knowledge-smoke-v2.md', mimeType: 'text/markdown',
    })
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) {
      const { documents } = await json<{ documents: { id: string; currentVersion: number; pendingVersion: number | null; errorMessage: string | null }[] }>(`/api/knowledge/bases/${baseId}/documents`)
      const doc = documents.find((item) => item.id === documentId)
      assert.ok(doc)
      if (doc.errorMessage) throw new Error(`replacement failed: ${doc.errorMessage}`)
      if (doc.currentVersion === 2 && doc.pendingVersion === null) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    assert.ok(ready, 'replacement indexing timed out')
    const latest = await json<{ status: string; sources: { content: string }[] }>(`/api/knowledge/bases/${baseId}/search`, 'POST', { query: expectedFact })
    assert.equal(latest.status, 'ok')
    assert.ok(latest.sources.some((source) => source.content.includes(expectedFact)))
    assert.ok(latest.sources.every((source) => !source.content.includes(fact)), 'old-version chunk leaked into search')
    const source = await app.request(`/api/knowledge/documents/${documentId}/source`)
    assert.equal(source.status, 302)
    console.log('replacement: version 2 indexed, old version excluded, source available')
  }

  const response = await app.request('/api/agent/run', { method: 'POST', headers, body: JSON.stringify({
    task: `根据知识库回答：${expectedFact}？请标注引用。`, knowledgeMode: 'required', knowledgeBaseIds: [baseId],
  }) })
  assert.ok(response.ok, `agent run: HTTP ${response.status}`)
  const stream = await response.text()
  const events = stream.split('\n').filter((line) => line.startsWith('data: ')).map((line) => {
    try { return JSON.parse(line.slice(6)) as { type: string; sessionId?: string; message?: string; result?: string; delta?: string } }
    catch { return null }
  }).filter((event) => event !== null)
  sessionId = events.find((event) => event.type === 'session')?.sessionId
  const tool = events.find((event) => event.type === 'tool_result' && event.result?.includes(expectedFact))
  assert.ok(tool, `agent retrieval missing; event types: ${events.map((event) => event.type).join(',')}`)
  const error = events.find((event) => event.type === 'error')
  if (error) throw new Error(`agent error: ${error.message}`)
  const answer = events.filter((event) => event.type === 'text_delta').map((event) => event.delta ?? '').join('')
  assert.ok(answer.includes(expectedFact), 'agent answer did not include the retrieved fact')
  assert.ok(answer.includes('[K1]'), 'agent answer did not cite the retrieved source')
  console.log('agent required retrieval: ok')
} finally {
  if (stopWorker) await stopWorker()
  if (sessionId) await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch((err) => console.error('session cleanup failed:', err))
  if (baseId) await json(`/api/knowledge/bases/${baseId}`, 'DELETE').catch((err) => console.error('base cleanup failed:', err))
  if (uploadKey) await deleteObject(uploadKey).catch((err) => console.error('upload cleanup failed:', err))
  if (replacementUploadKey) await deleteObject(replacementUploadKey).catch((err) => console.error('replacement upload cleanup failed:', err))
  await pool.end()
}
