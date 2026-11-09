import mammoth from 'mammoth'
import { DomUtils, parseDocument } from 'htmlparser2'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { Section } from './chunk.js'

const MAX_PAGES = 300
const MAX_OCR_PAGES = 30

async function ocrPdfPages(bytes: Uint8Array, pages: number[]): Promise<Section[]> {
  const key = process.env.MISTRAL_API_KEY
  if (!key) throw new Error('PDF 含扫描页；请配置 MISTRAL_API_KEY 启用 OCR 后重试。')
  if (pages.length > MAX_OCR_PAGES) throw new Error(`扫描页超过 ${MAX_OCR_PAGES} 页，请拆分 PDF 后重试。`)
  const response = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document: {
      type: 'document_url', document_url: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
    }, pages: pages.map((page) => page - 1), include_image_base64: false }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`PDF OCR 服务返回 ${response.status}。`)
  const result = await response.json() as { pages?: { index: number; markdown: string }[] }
  if (!result.pages) throw new Error('PDF OCR 服务未返回页面。')
  return result.pages.map((page) => ({ text: page.markdown, pageNumber: page.index + 1 }))
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
}

function parseMarkdown(text: string): Section[] {
  const sections: Section[] = []
  let heading = ''
  let body: string[] = []
  const flush = () => {
    if (body.length) sections.push({ text: body.join('\n'), headingPath: heading || undefined })
    body = []
  }
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+)/.exec(line)
    if (match) { flush(); heading = match[1].trim() }
    else body.push(line)
  }
  flush()
  return sections
}

export function parseWordHtml(html: string): Section[] {
  const document = parseDocument(html, { decodeEntities: true })
  const sections: Section[] = []
  const headings: string[] = []
  let body: string[] = []
  let headingPath: string | undefined
  const flush = () => {
    if (body.length) sections.push({ text: [headingPath, ...body].filter(Boolean).join('\n'), headingPath })
    body = []
  }
  const walk = (nodes: typeof document.children) => {
    for (const node of nodes) {
      if (node.type === 'tag') {
        const tag = node.name.toLowerCase()
        const isHeading = /^h[1-6]$/.test(tag)
        const isBlock = isHeading || tag === 'p' || tag === 'li'
        if (isBlock) {
          const value = DomUtils.innerText(node).replace(/\s+/g, ' ').trim()
          if (!value) continue
          const numberedHeading = tag === 'p' && value.length <= 80 && /^(?:[一二三四五六七八九十]+[、.]|\d+(?:\.\d+)*[、.])\s*\S/.test(value)
          if (isHeading || numberedHeading) {
            flush()
            const level = isHeading ? Number(tag[1]) : 2
            headings[level - 1] = value
            headings.length = level
            headingPath = headings.filter(Boolean).join(' / ')
          } else body.push(value)
          continue
        }
      }
      if ('children' in node) walk(node.children)
    }
  }
  walk(document.children)
  flush()
  return sections
}

export async function parseKnowledgeFile(bytes: Uint8Array, filename: string): Promise<Section[]> {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'txt') return [{ text: decodeText(bytes) }]
  if (ext === 'md' || ext === 'markdown') return parseMarkdown(decodeText(bytes))
  if (ext === 'docx') {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    })
    return parseWordHtml(result.value)
  }
  if (ext === 'pdf') {
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true })
    try {
      const pdf = await task.promise
      if (pdf.numPages > MAX_PAGES) throw new Error(`PDF 超过 ${MAX_PAGES} 页，请拆分后重试。`)
      const sections: Section[] = []
      const scannedPages: number[] = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').trim()
        if (text) sections.push({ text, pageNumber })
        else scannedPages.push(pageNumber)
      }
      if (scannedPages.length) sections.push(...await ocrPdfPages(bytes, scannedPages))
      sections.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
      return sections
    } finally {
      await task.destroy()
    }
  }
  throw new Error('仅支持 PDF、DOCX、Markdown 和 TXT 文件。')
}
