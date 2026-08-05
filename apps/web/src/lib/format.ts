export function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function prettyJson(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function parseResult<T>(result: string | undefined): T | null {
  if (result === undefined) return null
  try {
    return JSON.parse(result) as T
  } catch {
    return null
  }
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

// 历史消息里的附件只有文件名（没有真正的 mimeType——见
// apps/web/src/lib/blocks.ts 的 parseAttachmentNote），按后缀猜一下用不
// 用尝试渲染缩略图；猜错了顶多是该显示缩略图的没显示，不会渲染出一个
// 加载失败的 <img> 图标。
export function isLikelyImageFilename(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// 搜索摘要是从页面抓取的原始文本——经常充斥着 markdown 表格、标题和
// 列表项符号。把这些去掉、只保留纯文本，这样预览读起来像一句话，
// 而不会漏出 "| --- |" 这种表格语法。
export function cleanSnippet(text: string): string {
  const prose = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('|') && !/^[-#*:\s]+$/.test(line))
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, ''))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return prose.length > 220 ? prose.slice(0, 220).trimEnd() + '…' : prose
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

export function formatRelativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  // updated_at 理论上总是服务端写入的合法时间戳，但这里被 Sidebar 会话列表
  // 对每一行都调用一次——一旦真的遇到非法/缺失的值，`diffMs` 会是 NaN，
  // 后面 Intl.RelativeTimeFormat.format(NaN, ...) 会直接抛 RangeError，
  // 炸掉整个列表的渲染而不只是这一行。兜底返回空字符串，让这一行退化成
  // "没有时间说明"而不是让整个侧边栏白屏。
  if (Number.isNaN(diffMs)) return ''
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) return relativeTimeFormatter.format(diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return relativeTimeFormatter.format(diffHours, 'hour')
  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
}
