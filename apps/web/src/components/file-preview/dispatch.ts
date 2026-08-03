export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'csv' | 'text' | 'office' | 'unsupported'

const OFFICE_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac'])
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'log', 'yaml', 'yml', 'xml'])

// Trusts mimeType first (it's what the server/agent actually recorded), and
// only falls back to sniffing the filename's extension when mimeType is
// missing/generic (application/octet-stream) — e.g. a browser upload whose
// reported type was empty.
export function pickPreviewKind(mimeType: string, filename: string): PreviewKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'text/csv') return 'csv'
  if (OFFICE_MIME_TYPES.has(mimeType)) return 'office'
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text'

  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (ext === 'csv') return 'csv'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'unsupported'
}
