import { Hono } from 'hono'
import * as Sentry from '@sentry/hono/node'
import type { ApiEnv } from '../app-setup.js'
import { getOwnerId, requireAuth } from '../auth.js'
import { searchKnowledge } from '../knowledge/search.js'
import {
  addKnowledgeDocument, createKnowledgeBase, deleteKnowledgeBase, deleteKnowledgeDocument,
  getKnowledgeDocumentSource, KnowledgeError, listKnowledgeBases, listKnowledgeDocuments,
  replaceKnowledgeDocument, reindexKnowledgeDocument, retryKnowledgeDocument,
} from '../knowledge/store.js'

export const knowledgeRouter = new Hono<ApiEnv>()
knowledgeRouter.use('*', requireAuth)
knowledgeRouter.onError((err, c) => {
  if (err instanceof KnowledgeError) return c.json({ error: err.message }, err.status)
  Sentry.captureException(err)
  console.error('knowledge API failed:', err)
  c.set('sentryResponseError', '知识库请求失败，请稍后重试。')
  c.set('sentryFailureType', err.name)
  return c.json({ error: '知识库请求失败，请稍后重试。' }, 500)
})

knowledgeRouter.get('/bases', async (c) => c.json({ bases: await listKnowledgeBases(await getOwnerId(c)) }))
knowledgeRouter.post('/bases', async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>().catch(() => ({} as { name?: string; description?: string }))
  return c.json({ base: await createKnowledgeBase(await getOwnerId(c), body.name ?? '', body.description ?? '') }, 201)
})
knowledgeRouter.delete('/bases/:id', async (c) => {
  await deleteKnowledgeBase(c.req.param('id'), await getOwnerId(c))
  return c.json({ ok: true })
})
knowledgeRouter.get('/bases/:id/documents', async (c) =>
  c.json({ documents: await listKnowledgeDocuments(c.req.param('id'), await getOwnerId(c)) }))
knowledgeRouter.post('/bases/:id/documents', async (c) => {
  const body = await c.req.json<{ key?: string; filename?: string; mimeType?: string }>().catch(() => ({} as { key?: string; filename?: string; mimeType?: string }))
  if (!body.key || !body.filename || !body.mimeType) throw new KnowledgeError('缺少上传文件信息。')
  return c.json(await addKnowledgeDocument(c.req.param('id'), await getOwnerId(c), {
    key: body.key, filename: body.filename, mimeType: body.mimeType,
  }), 202)
})
knowledgeRouter.put('/documents/:id', async (c) => {
  const body = await c.req.json<{ key?: string; filename?: string; mimeType?: string }>().catch(() => ({} as { key?: string; filename?: string; mimeType?: string }))
  if (!body.key || !body.filename || !body.mimeType) throw new KnowledgeError('缺少上传文件信息。')
  return c.json(await replaceKnowledgeDocument(c.req.param('id'), await getOwnerId(c), {
    key: body.key, filename: body.filename, mimeType: body.mimeType,
  }), 202)
})
knowledgeRouter.post('/documents/:id/retry', async (c) => {
  await retryKnowledgeDocument(c.req.param('id'), await getOwnerId(c))
  return c.json({ ok: true })
})
knowledgeRouter.post('/documents/:id/reindex', async (c) =>
  c.json(await reindexKnowledgeDocument(c.req.param('id'), await getOwnerId(c)), 202))
knowledgeRouter.delete('/documents/:id', async (c) => {
  await deleteKnowledgeDocument(c.req.param('id'), await getOwnerId(c))
  return c.json({ ok: true })
})
knowledgeRouter.get('/documents/:id/source', async (c) =>
  c.redirect(await getKnowledgeDocumentSource(c.req.param('id'), await getOwnerId(c))))
knowledgeRouter.post('/search', async (c) => {
  const body = await c.req.json<{ query?: string; limit?: number }>().catch(() => ({} as { query?: string; limit?: number }))
  if (typeof body.query !== 'string') throw new KnowledgeError('缺少检索问题。')
  return c.json(await searchKnowledge(await getOwnerId(c), { query: body.query, limit: body.limit }))
})
knowledgeRouter.post('/bases/:id/search', async (c) => {
  const body = await c.req.json<{ query?: string; documentIds?: string[]; limit?: number }>().catch(() => ({} as { query?: string; documentIds?: string[]; limit?: number }))
  if (typeof body.query !== 'string') throw new KnowledgeError('缺少检索问题。')
  return c.json(await searchKnowledge(await getOwnerId(c), {
    query: body.query, knowledgeBaseIds: [c.req.param('id')], documentIds: body.documentIds, limit: body.limit,
  }))
})
