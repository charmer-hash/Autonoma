export type Section = { text: string; pageNumber?: number; headingPath?: string }
export type KnowledgeChunk = Section & { ordinal: number; startOffset: number; endOffset: number }

const TARGET_CHARS = 900
const OVERLAP_CHARS = 120
const MAX_EXTRACTED_CHARS = 2_000_000
const MAX_CHUNKS = 2000

export function chunkSections(sections: Section[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []
  let extractedChars = 0
  for (const section of sections) {
    const text = section.text.replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    extractedChars += text.length
    if (extractedChars > MAX_EXTRACTED_CHARS) throw new Error('提取的文字超过 200 万字符，请拆分文档后重试。')
    if (!text) continue
    let start = 0
    while (start < text.length) {
      let end = Math.min(start + TARGET_CHARS, text.length)
      if (end < text.length) {
        const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('。', end), text.lastIndexOf('.', end))
        if (boundary > start + TARGET_CHARS * 0.6) end = boundary + 1
      }
      const content = text.slice(start, end).trim()
      if (content) chunks.push({ ...section, text: content, ordinal: chunks.length, startOffset: start, endOffset: end })
      if (chunks.length > MAX_CHUNKS) throw new Error('分片超过 2000 个，请拆分文档后重试。')
      if (end === text.length) break
      start = Math.max(start + 1, end - OVERLAP_CHARS)
    }
  }
  if (chunks.length === 0) throw new Error('文档没有可索引的文字。')
  return chunks
}
