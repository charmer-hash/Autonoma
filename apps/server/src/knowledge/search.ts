import { and, eq, inArray, isNull } from 'drizzle-orm'
import { pool } from '../db/client.js'
import { knowledgeBases, knowledgeDocuments } from '../db/schema.js'
import { db, KnowledgeError } from './store.js'
import { embedTexts } from './embeddings.js'

// Provisional rejection threshold. Calibrate against a labeled retrieval set before production.
const MIN_VECTOR_SIMILARITY = 0.5
const MAX_VECTOR_GAP = 0.1

export type KnowledgeSource = {
  ref: string
  chunkId: string
  documentId: string
  filename: string
  pageNumber: number | null
  headingPath: string | null
  content: string
  score: number
}
export type KnowledgeSearchResult = {
  status: 'ok' | 'empty' | 'degraded'
  query: string
  sources: KnowledgeSource[]
  warning?: string
}

type SearchRow = {
  chunk_id: string
  document_id: string
  filename: string
  page_number: number | null
  heading_path: string | null
  content: string
  vector_similarity?: number
}

function headingMatchBonus(query: string, heading: string | null): number {
  if (!heading) return 0
  const normalizedQuery = query.toLocaleLowerCase()
  const leafHeading = heading.split(' / ').at(-1) ?? heading
  const words = leafHeading.toLocaleLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) ?? []
  const matches = new Set<string>()
  for (const word of words) {
    for (let index = 0; index < word.length - 1; index++) {
      const pair = word.slice(index, index + 2)
      if (normalizedQuery.includes(pair)) matches.add(pair)
    }
  }
  return Math.min(matches.size, 2) * 0.012
}

export async function searchKnowledge(ownerId: string | undefined, input: {
  query: string; knowledgeBaseIds?: string[]; documentIds?: string[]; limit?: number
}): Promise<KnowledgeSearchResult> {
  const query = input.query?.trim()
  if (!query || query.length > 500) throw new KnowledgeError('检索问题长度必须在 1–500 字之间。')
  if (input.knowledgeBaseIds && (!Array.isArray(input.knowledgeBaseIds) || input.knowledgeBaseIds.some((id) => typeof id !== 'string' || !id || id.length > 100))) throw new KnowledgeError('知识库范围无效。')
  if (input.documentIds && (!Array.isArray(input.documentIds) || input.documentIds.some((id) => typeof id !== 'string' || !id || id.length > 100))) throw new KnowledgeError('文档范围无效。')
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8)) throw new KnowledgeError('返回数量必须在 1–8 之间。')
  const baseIds = input.knowledgeBaseIds ? [...new Set(input.knowledgeBaseIds)] : undefined
  const documentIds = input.documentIds ? [...new Set(input.documentIds)] : undefined
  if (baseIds?.length && baseIds.length > 20) throw new KnowledgeError('一次最多检索 20 个知识库。')
  if (documentIds?.length && documentIds.length > 50) throw new KnowledgeError('一次最多限定 50 个文档。')
  const owner = ownerId ? eq(knowledgeBases.ownerId, ownerId) : isNull(knowledgeBases.ownerId)
  if (baseIds?.length) {
    const allowed = await db.select({ id: knowledgeBases.id }).from(knowledgeBases)
      .where(and(owner, inArray(knowledgeBases.id, baseIds)))
    if (allowed.length !== baseIds.length) throw new KnowledgeError('知识库不存在或无权访问。', 403)
  }
  if (documentIds?.length) {
    const allowed = await db.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments)
      .innerJoin(knowledgeBases, eq(knowledgeDocuments.knowledgeBaseId, knowledgeBases.id))
      .where(and(owner, inArray(knowledgeDocuments.id, documentIds), ...(baseIds?.length ? [inArray(knowledgeBases.id, baseIds)] : [])))
    if (allowed.length !== documentIds.length) throw new KnowledgeError('文档不存在或无权访问。', 403)
  }

  const params = [ownerId ?? null, baseIds?.length ? baseIds : null, documentIds?.length ? documentIds : null, query]
  const scope = `FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
    JOIN knowledge_bases b ON b.id = d.knowledge_base_id
    WHERE b.owner_id IS NOT DISTINCT FROM $1::text
      AND d.status = 'ready' AND d.current_version = c.document_version
      AND ($2::text[] IS NULL OR b.id = ANY($2::text[]))
      AND ($3::text[] IS NULL OR d.id = ANY($3::text[]))`
  const fields = `c.id::text AS chunk_id, d.id AS document_id, d.filename, c.page_number, c.heading_path, c.content`
  const keywordPromise = pool.query<SearchRow>(`SELECT ${fields} ${scope}
    AND (position(lower($4::text) in lower(c.content)) > 0 OR position(lower($4::text) in lower(d.filename)) > 0
      OR similarity(c.content, $4::text) > 0.05 OR similarity(d.filename, $4::text) > 0.05)
    ORDER BY (CASE WHEN position(lower($4::text) in lower(d.filename)) > 0 THEN 1 ELSE 0 END) DESC,
      similarity(c.content, $4::text) DESC, similarity(d.filename, $4::text) DESC LIMIT 40`, params)
    .then((result) => ({ rows: result.rows, error: null as string | null }), (err: unknown) => ({
      rows: [] as SearchRow[], error: err instanceof Error ? err.message : String(err),
    }))
  let vectorRows: SearchRow[] = []
  let vectorError: string | undefined
  try {
    const [embedding] = await embedTexts([query])
    const vector = `[${embedding.join(',')}]`
    const result = await pool.query<SearchRow>(`SELECT ${fields}, 1 - (c.embedding <=> $4::vector) AS vector_similarity ${scope}
      AND (c.embedding <=> $4::vector) <= $5::double precision
      ORDER BY c.embedding <=> $4::vector LIMIT 40`, [...params.slice(0, 3), vector, 1 - MIN_VECTOR_SIMILARITY])
    const bestSimilarity = result.rows[0]?.vector_similarity
    vectorRows = bestSimilarity === undefined ? result.rows : result.rows.filter((row) =>
      row.vector_similarity === undefined || row.vector_similarity >= bestSimilarity - MAX_VECTOR_GAP)
  } catch (err) {
    vectorError = err instanceof Error ? err.message : String(err)
    console.error('knowledge vector retrieval failed:', vectorError)
  }
  const keywordResult = await keywordPromise
  if (keywordResult.error) console.error('knowledge keyword retrieval failed:', keywordResult.error)
  if (keywordResult.error && vectorError) throw new Error('知识库检索服务暂时不可用。')
  const keywordRows = keywordResult.rows
  const ranks = new Map<string, { row: SearchRow; score: number }>()
  for (const [channel, rows] of [vectorRows, keywordRows].entries()) {
    rows.forEach((row, index) => {
      const current = ranks.get(row.chunk_id) ?? { row, score: 0 }
      current.score += (channel === 0 ? 2 : 1) / (60 + index + 1)
      ranks.set(row.chunk_id, current)
    })
  }
  for (const candidate of ranks.values()) candidate.score += headingMatchBonus(query, candidate.row.heading_path)
  const max = Math.min(Math.max(input.limit ?? 6, 1), 8)
  const perDocument = new Map<string, number>()
  const sources: KnowledgeSource[] = []
  for (const { row, score } of [...ranks.values()].sort((a, b) => b.score - a.score)) {
    if (sources.length >= max) break
    const count = perDocument.get(row.document_id) ?? 0
    if (count >= 3) continue
    perDocument.set(row.document_id, count + 1)
    sources.push({
      ref: `K${sources.length + 1}`, chunkId: row.chunk_id, documentId: row.document_id,
      filename: row.filename, pageNumber: row.page_number, headingPath: row.heading_path,
      content: row.content, score,
    })
  }
  return { status: vectorError || keywordResult.error ? 'degraded' : sources.length === 0 ? 'empty' : 'ok', query, sources,
    ...(vectorError ? { warning: '向量检索不可用，本次仅使用关键词检索。' } :
      keywordResult.error ? { warning: '关键词检索不可用，本次仅使用向量检索。' } : {}) }
}

export function formatKnowledgeResult(result: KnowledgeSearchResult): string {
  if (result.sources.length === 0) return JSON.stringify({ ...result, message: '在指定知识库范围内未找到相关证据。不要根据模型记忆补写内部资料。' })
  return JSON.stringify(result)
}
