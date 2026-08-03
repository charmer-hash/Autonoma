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

// Search snippets are raw scraped page text — often full of markdown tables,
// headings, and list bullets. Strip that down to plain prose so the preview
// reads like a sentence instead of leaking "| --- |" table syntax.
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
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) return relativeTimeFormatter.format(diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return relativeTimeFormatter.format(diffHours, 'hour')
  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
}
