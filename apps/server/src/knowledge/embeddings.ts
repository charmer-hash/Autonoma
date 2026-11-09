export const EMBEDDING_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL ?? 'baai/bge-m3'
export const EMBEDDING_DIMENSIONS = 1024

type EmbeddingResponse = { data?: { index: number; embedding: number[] }[] }

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY 未配置，无法生成知识库向量。')
  const results: number[][] = []
  for (let offset = 0; offset < texts.length; offset += 16) {
    const batch = texts.slice(offset, offset + 16)
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      if (response.status === 401) throw new Error('OPENROUTER_API_KEY 无效或已失效，请更新服务端密钥。')
      if (response.status === 402) throw new Error('OpenRouter 额度不足，无法生成知识库向量。')
      throw new Error(`向量服务返回 ${response.status}。`)
    }
    const data = await response.json() as EmbeddingResponse
    if (!data.data || data.data.length !== batch.length) throw new Error('向量服务返回数量不匹配。')
    for (const item of data.data.sort((a, b) => a.index - b.index)) {
      if (item.embedding.length !== EMBEDDING_DIMENSIONS || item.embedding.some((n) => !Number.isFinite(n))) {
        throw new Error(`向量维度不匹配，预期 ${EMBEDDING_DIMENSIONS}。`)
      }
      results.push(item.embedding)
    }
  }
  return results
}
