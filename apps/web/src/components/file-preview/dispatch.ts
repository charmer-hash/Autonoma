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

// 优先信任 mimeType（这是服务端/agent 实际记录下来的），只有当 mimeType
// 缺失或是通用类型（application/octet-stream）时，才回退到通过文件名后缀
// 来嗅探类型——比如浏览器上传时报告的类型为空的情况。
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
