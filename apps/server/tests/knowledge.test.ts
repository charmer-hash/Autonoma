import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkSections } from '../src/knowledge/chunk.js'
import { parseKnowledgeFile, parseWordHtml } from '../src/knowledge/parse.js'

test('Word headings produce separate sections with hierarchy', () => {
  const sections = parseWordHtml('<h1>产品文档</h1><h2>验收步骤</h2><p>检查播放列表。</p><p>1. 回归测试</p><p>确认状态码。</p>')
  assert.deepEqual(sections.map((section) => section.headingPath), [
    '产品文档 / 验收步骤', '产品文档 / 1. 回归测试',
  ])
  assert.match(sections[0].text, /检查播放列表/)
  assert.match(sections[1].text, /确认状态码/)
})
import { embedTexts, EMBEDDING_DIMENSIONS } from '../src/knowledge/embeddings.js'

test('Markdown headings are carried into chunks and long sections overlap', async () => {
  const markdown = `# 产品说明\n${'甲'.repeat(1900)}\n## 限制\n仅限测试。`
  const sections = await parseKnowledgeFile(new TextEncoder().encode(markdown), 'sample.md')
  const chunks = chunkSections(sections)
  assert.ok(chunks.length >= 4)
  assert.equal(chunks[0].headingPath, '产品说明')
  assert.equal(chunks.at(-1)?.headingPath, '限制')
  assert.equal(chunks[0].text.slice(-120), chunks[1].text.slice(0, 120))
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), chunks.map((_, index) => index))
})

test('TXT UTF-16 is decoded and empty documents are rejected', async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])
  assert.equal((await parseKnowledgeFile(bytes, 'note.txt'))[0].text, 'AB')
  assert.throws(() => chunkSections([{ text: '  \n\n  ' }]), /没有可索引的文字/)
})

test('text PDF preserves page number during extraction', async () => {
  const stream = 'BT /F1 12 Tf 72 200 Td (Hello PDF) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const sections = await parseKnowledgeFile(new TextEncoder().encode(pdf), 'sample.pdf')
  assert.deepEqual(sections, [{ text: 'Hello PDF', pageNumber: 1 }])
})

test('chunking rejects oversized extracted text', () => {
  assert.throws(() => chunkSections([{ text: 'A'.repeat(2_000_001) }]), /超过 200 万字符/)
})

test('embedding batches preserve API indices and enforce the vector dimension', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY
  const previousFetch = globalThis.fetch
  process.env.OPENROUTER_API_KEY = 'test-key'
  const vector = (value: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => value)
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      assert.deepEqual(body.input, ['first', 'second'])
      return new Response(JSON.stringify({ data: [
        { index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) },
      ] }), { status: 200 })
    }
    const embeddings = await embedTexts(['first', 'second'])
    assert.equal(embeddings[0][0], 1)
    assert.equal(embeddings[1][0], 2)

    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 })
    await assert.rejects(() => embedTexts(['bad']), /向量维度不匹配/)

    globalThis.fetch = async () => new Response('{}', { status: 401 })
    await assert.rejects(() => embedTexts(['bad']), /OPENROUTER_API_KEY 无效/)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  }
})
