import { createHash } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { knowledgeBases, knowledgeChunks, knowledgeDocuments, knowledgeJobs } from '../db/schema.js'
import { deleteObject, getObjectBytes, getObjectSize, getPresignedDownloadUrl, uploadArtifact } from '../lib/storage.js'
import { withRetry } from '../lib/retry.js'

export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', 'md', 'markdown', 'txt'])

export class KnowledgeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message) }
}

const ownerFilter = (ownerId: string | undefined) => ownerId ? eq(knowledgeBases.ownerId, ownerId) : isNull(knowledgeBases.ownerId)

export async function listKnowledgeBases(ownerId: string | undefined) {
  return withRetry(() => db.select().from(knowledgeBases).where(ownerFilter(ownerId)).orderBy(desc(knowledgeBases.updatedAt)))
}

export async function getKnowledgeBase(id: string, ownerId: string | undefined) {
  const [base] = await withRetry(() => db.select().from(knowledgeBases).where(and(eq(knowledgeBases.id, id), ownerFilter(ownerId))).limit(1))
  if (!base) throw new KnowledgeError('知识库不存在或无权访问。', 404)
  return base
}

export async function createKnowledgeBase(ownerId: string | undefined, name: string, description = '') {
  if (!name.trim() || name.length > 100 || description.length > 1000) throw new KnowledgeError('知识库名称或描述长度不符合要求。')
  const [base] = await db.insert(knowledgeBases).values({ id: crypto.randomUUID(), ownerId: ownerId ?? null, name: name.trim(), description: description.trim() }).returning()
  return base
}

export async function deleteKnowledgeBase(id: string, ownerId: string | undefined) {
  await getKnowledgeBase(id, ownerId)
  const docs = await withRetry(() => db.select({ currentR2Key: knowledgeDocuments.currentR2Key, pendingR2Key: knowledgeDocuments.pendingR2Key })
    .from(knowledgeDocuments).where(eq(knowledgeDocuments.knowledgeBaseId, id)))
  await withRetry(() => db.delete(knowledgeBases).where(eq(knowledgeBases.id, id)))
  for (const doc of docs) for (const key of [doc.currentR2Key, doc.pendingR2Key]) {
    if (key) await deleteObject(key).catch((err) => console.error('knowledge object cleanup failed:', err))
  }
}

export async function listKnowledgeDocuments(baseId: string, ownerId: string | undefined) {
  await getKnowledgeBase(baseId, ownerId)
  return withRetry(() => db.select({
    id: knowledgeDocuments.id, filename: knowledgeDocuments.filename, mimeType: knowledgeDocuments.mimeType,
    sizeBytes: knowledgeDocuments.sizeBytes, status: knowledgeDocuments.status,
    errorMessage: knowledgeDocuments.errorMessage, chunkCount: knowledgeDocuments.chunkCount,
    currentVersion: knowledgeDocuments.currentVersion, pendingVersion: knowledgeDocuments.pendingVersion,
    createdAt: knowledgeDocuments.createdAt, updatedAt: knowledgeDocuments.updatedAt,
  }).from(knowledgeDocuments).where(eq(knowledgeDocuments.knowledgeBaseId, baseId)).orderBy(desc(knowledgeDocuments.createdAt)))
}

export async function getKnowledgeDocument(id: string, ownerId: string | undefined) {
  const [result] = await withRetry(() => db.select({ doc: knowledgeDocuments, base: knowledgeBases })
    .from(knowledgeDocuments).innerJoin(knowledgeBases, eq(knowledgeDocuments.knowledgeBaseId, knowledgeBases.id))
    .where(and(eq(knowledgeDocuments.id, id), ownerFilter(ownerId))).limit(1))
  if (!result) throw new KnowledgeError('文档不存在或无权访问。', 404)
  return result.doc
}

async function prepareUpload(ownerId: string | undefined, key: string, filename: string) {
  if (!key.startsWith(`uploads/${ownerId ?? 'anon'}/`)) throw new KnowledgeError('无权访问该上传文件。', 403)
  const safeName = filename.split(/[/\\]/).pop()?.trim() ?? ''
  const extension = safeName.split('.').pop()?.toLowerCase()
  if (!safeName || !extension || !ALLOWED_EXTENSIONS.has(extension)) throw new KnowledgeError('仅支持 PDF、DOCX、Markdown 和 TXT 文件。')
  const sizeBytes = await getObjectSize(key)
  if (sizeBytes < 1 || sizeBytes > MAX_KNOWLEDGE_FILE_BYTES) throw new KnowledgeError('知识库文件大小必须在 1 字节到 20 MB 之间。')
  const bytes = await getObjectBytes(key)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { safeName, sizeBytes, bytes, sha256 }
}

export async function addKnowledgeDocument(baseId: string, ownerId: string | undefined, input: { key: string; filename: string; mimeType: string }) {
  await getKnowledgeBase(baseId, ownerId)
  const upload = await prepareUpload(ownerId, input.key, input.filename)
  const [duplicate] = await db.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.knowledgeBaseId, baseId), eq(knowledgeDocuments.sha256, upload.sha256))).limit(1)
  if (duplicate) throw new KnowledgeError('该文件内容已在知识库中。', 409)
  const id = crypto.randomUUID()
  const r2Key = `knowledge/${ownerId ?? 'anon'}/${baseId}/${id}/v1/${upload.safeName}`
  await uploadArtifact(r2Key, upload.bytes, input.mimeType)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(knowledgeDocuments).values({
        id, knowledgeBaseId: baseId, filename: upload.safeName, mimeType: input.mimeType,
        sizeBytes: upload.sizeBytes, sha256: upload.sha256, pendingR2Key: r2Key, pendingVersion: 1,
        pendingFilename: upload.safeName, pendingMimeType: input.mimeType,
        pendingSizeBytes: upload.sizeBytes, pendingSha256: upload.sha256,
      })
      await tx.insert(knowledgeJobs).values({ id: crypto.randomUUID(), documentId: id, documentVersion: 1 })
    })
  } catch (err) {
    await deleteObject(r2Key).catch(() => {})
    throw err
  }
  return { id }
}

export async function replaceKnowledgeDocument(id: string, ownerId: string | undefined, input: { key: string; filename: string; mimeType: string }) {
  const doc = await getKnowledgeDocument(id, ownerId)
  if (doc.pendingVersion) throw new KnowledgeError('该文档已有导入任务正在处理。', 409)
  const upload = await prepareUpload(ownerId, input.key, input.filename)
  if (upload.sha256 === doc.sha256) throw new KnowledgeError('新文件与当前版本相同。', 409)
  const version = doc.currentVersion + 1
  const r2Key = `knowledge/${ownerId ?? 'anon'}/${doc.knowledgeBaseId}/${id}/v${version}/${upload.safeName}`
  await uploadArtifact(r2Key, upload.bytes, input.mimeType)
  try {
    await db.transaction(async (tx) => {
      await tx.update(knowledgeDocuments).set({
        pendingFilename: upload.safeName, pendingMimeType: input.mimeType,
        pendingSizeBytes: upload.sizeBytes, pendingSha256: upload.sha256,
        pendingR2Key: r2Key, pendingVersion: version,
        errorMessage: null, updatedAt: new Date(),
      }).where(eq(knowledgeDocuments.id, id))
      await tx.insert(knowledgeJobs).values({ id: crypto.randomUUID(), documentId: id, documentVersion: version })
    })
  } catch (err) {
    await deleteObject(r2Key).catch(() => {})
    throw err
  }
  return { id, version }
}

export async function reindexKnowledgeDocument(id: string, ownerId: string | undefined) {
  const doc = await getKnowledgeDocument(id, ownerId)
  if (!doc.currentR2Key || doc.currentVersion === 0) throw new KnowledgeError('文档尚未完成首次索引。', 409)
  if (doc.pendingVersion) throw new KnowledgeError('该文档已有导入任务正在处理。', 409)
  const version = doc.currentVersion + 1
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(knowledgeDocuments).set({
      pendingFilename: doc.filename, pendingMimeType: doc.mimeType,
      pendingSizeBytes: doc.sizeBytes, pendingSha256: doc.sha256,
      pendingR2Key: doc.currentR2Key, pendingVersion: version,
      errorMessage: null, updatedAt: new Date(),
    }).where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.currentVersion, doc.currentVersion), isNull(knowledgeDocuments.pendingVersion))).returning({ id: knowledgeDocuments.id })
    if (!updated) throw new KnowledgeError('该文档已有导入任务正在处理。', 409)
    await tx.insert(knowledgeJobs).values({ id: crypto.randomUUID(), documentId: id, documentVersion: version })
  })
  return { id, version }
}

export async function retryKnowledgeDocument(id: string, ownerId: string | undefined) {
  const doc = await getKnowledgeDocument(id, ownerId)
  if (!doc.pendingVersion) throw new KnowledgeError('该文档没有可重试的导入任务。', 409)
  const [job] = await db.select().from(knowledgeJobs).where(and(eq(knowledgeJobs.documentId, id), eq(knowledgeJobs.documentVersion, doc.pendingVersion))).limit(1)
  if (!job || job.status !== 'failed') throw new KnowledgeError('导入任务尚未失败。', 409)
  await db.transaction(async (tx) => {
    await tx.update(knowledgeJobs).set({ status: 'queued', attempts: 0, lastError: null, leaseUntil: null, updatedAt: new Date() }).where(eq(knowledgeJobs.id, job.id))
    await tx.update(knowledgeDocuments).set({ status: doc.currentVersion ? 'ready' : 'queued', errorMessage: null, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, id))
  })
}

export async function deleteKnowledgeDocument(id: string, ownerId: string | undefined) {
  const doc = await getKnowledgeDocument(id, ownerId)
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id))
  for (const key of [doc.currentR2Key, doc.pendingR2Key]) {
    if (key) await deleteObject(key).catch((err) => console.error('knowledge object cleanup failed:', err))
  }
}

export async function getKnowledgeDocumentSource(id: string, ownerId: string | undefined) {
  const doc = await getKnowledgeDocument(id, ownerId)
  if (!doc.currentR2Key) throw new KnowledgeError('文档尚未完成索引。', 409)
  return getPresignedDownloadUrl(doc.currentR2Key, { filename: doc.filename, mimeType: doc.mimeType, disposition: 'inline' })
}

export { knowledgeChunks, knowledgeDocuments, knowledgeJobs, db }
