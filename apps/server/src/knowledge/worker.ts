import { and, eq } from 'drizzle-orm'
import { pool } from '../db/client.js'
import { deleteObject, getObjectBytes, getObjectSize } from '../lib/storage.js'
import { chunkSections } from './chunk.js'
import { embedTexts } from './embeddings.js'
import { parseKnowledgeFile } from './parse.js'
import { db, knowledgeChunks, knowledgeDocuments, knowledgeJobs, MAX_KNOWLEDGE_FILE_BYTES } from './store.js'

type ClaimedJob = { id: string; document_id: string; document_version: number }

async function claimJob(): Promise<ClaimedJob | undefined> {
  await pool.query(`UPDATE knowledge_jobs SET status = 'failed', last_error = '导入进程多次中断，请手动重试。'
    WHERE status = 'processing' AND lease_until < now() AND attempts >= 3`)
  await pool.query(`UPDATE knowledge_documents d SET status = CASE WHEN d.current_version > 0 THEN 'ready' ELSE 'failed' END,
    error_message = '导入进程多次中断，请手动重试。', updated_at = now()
    FROM knowledge_jobs j WHERE j.document_id = d.id AND j.document_version = d.pending_version
      AND j.status = 'failed' AND d.error_message IS NULL`)
  const result = await pool.query<ClaimedJob>(`UPDATE knowledge_jobs SET status = 'processing', attempts = attempts + 1,
      lease_until = now() + interval '30 minutes', updated_at = now()
    WHERE id = (SELECT id FROM knowledge_jobs
      WHERE status = 'queued' OR (status = 'processing' AND lease_until < now() AND attempts < 3)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, document_id, document_version`)
  return result.rows[0]
}

async function processJob(job: ClaimedJob): Promise<void> {
  const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, job.document_id)).limit(1)
  if (!doc || doc.pendingVersion !== job.document_version || !doc.pendingR2Key) {
    await db.update(knowledgeJobs).set({ status: 'done', leaseUntil: null, updatedAt: new Date() }).where(eq(knowledgeJobs.id, job.id))
    return
  }
  try {
    const size = await getObjectSize(doc.pendingR2Key)
    if (size > MAX_KNOWLEDGE_FILE_BYTES) throw new Error('R2 中的文件超过 20 MB。')
    const sections = await parseKnowledgeFile(await getObjectBytes(doc.pendingR2Key), doc.pendingFilename ?? doc.filename)
    const chunks = chunkSections(sections)
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text))
    const previousR2Key = doc.currentR2Key
    let committed = false
    await db.transaction(async (tx) => {
      const [fresh] = await tx.select({ pendingVersion: knowledgeDocuments.pendingVersion })
        .from(knowledgeDocuments).where(eq(knowledgeDocuments.id, doc.id)).limit(1)
      if (fresh?.pendingVersion !== job.document_version) return
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, doc.id))
      for (let offset = 0; offset < chunks.length; offset += 100) {
        await tx.insert(knowledgeChunks).values(chunks.slice(offset, offset + 100).map((chunk, index) => ({
          documentId: doc.id, documentVersion: job.document_version,
          ordinal: chunk.ordinal, pageNumber: chunk.pageNumber ?? null, headingPath: chunk.headingPath ?? null,
          startOffset: chunk.startOffset, endOffset: chunk.endOffset, content: chunk.text,
          embedding: embeddings[offset + index],
        })))
      }
      await tx.update(knowledgeDocuments).set({
        currentVersion: job.document_version, currentR2Key: doc.pendingR2Key,
        filename: doc.pendingFilename ?? doc.filename, mimeType: doc.pendingMimeType ?? doc.mimeType,
        sizeBytes: doc.pendingSizeBytes ?? doc.sizeBytes, sha256: doc.pendingSha256 ?? doc.sha256,
        pendingVersion: null, pendingR2Key: null, pendingFilename: null, pendingMimeType: null,
        pendingSizeBytes: null, pendingSha256: null, status: 'ready', errorMessage: null,
        chunkCount: chunks.length, updatedAt: new Date(),
      }).where(eq(knowledgeDocuments.id, doc.id))
      await tx.update(knowledgeJobs).set({ status: 'done', leaseUntil: null, updatedAt: new Date() }).where(eq(knowledgeJobs.id, job.id))
      committed = true
    })
    if (committed && previousR2Key && previousR2Key !== doc.pendingR2Key) {
      await deleteObject(previousR2Key).catch((err) => console.error('knowledge previous-version cleanup failed:', err))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('knowledge indexing failed:', { documentId: doc.id, version: job.document_version, error: message })
    await db.transaction(async (tx) => {
      await tx.update(knowledgeJobs).set({ status: 'failed', leaseUntil: null, lastError: message.slice(0, 1000), updatedAt: new Date() }).where(eq(knowledgeJobs.id, job.id))
      await tx.update(knowledgeDocuments).set({
        status: doc.currentVersion > 0 ? 'ready' : 'failed', errorMessage: message.slice(0, 1000), updatedAt: new Date(),
      }).where(and(eq(knowledgeDocuments.id, doc.id), eq(knowledgeDocuments.pendingVersion, job.document_version)))
    })
  }
}

export function startKnowledgeWorker(): () => Promise<void> {
  let busy = false
  let stopped = false
  let activeTick: Promise<void> = Promise.resolve()
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const job = await claimJob()
      if (job) await processJob(job)
    } catch (err) {
      console.error('knowledge worker failed:', err)
    } finally {
      busy = false
    }
  }
  const runTick = () => { activeTick = tick() }
  runTick()
  const timer = setInterval(runTick, 3000)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
    await activeTick
  }
}
