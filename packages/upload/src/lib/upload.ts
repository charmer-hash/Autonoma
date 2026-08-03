import type { PresignedUpload, PresignedUploadRequest } from '@autonoma/shared'

export type UploadProgress = { loaded: number; total: number; percent: number }

export type UploadRules = {
  // MIME patterns, e.g. ['image/*', 'application/pdf']. Undefined = any type.
  accept?: string[]
  maxSizeBytes?: number
}

export class UploadValidationError extends Error {}

export function validateFile(file: File, rules?: UploadRules): void {
  if (rules?.maxSizeBytes !== undefined && file.size > rules.maxSizeBytes) {
    throw new UploadValidationError(`文件过大：${formatBytes(file.size)}，最大允许 ${formatBytes(rules.maxSizeBytes)}。`)
  }
  if (rules?.accept?.length && !rules.accept.some((pattern) => mimeMatches(file.type, pattern))) {
    throw new UploadValidationError(`不支持的文件类型：${file.type || '未知'}。`)
  }
}

function mimeMatches(mimeType: string, pattern: string): boolean {
  if (pattern === mimeType) return true
  if (!pattern.endsWith('/*')) return false
  return mimeType.startsWith(pattern.slice(0, -1))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export type UploadOptions = {
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}

// `url` is the presigned PUT URL that was used, echoed back mostly for
// debugging — it's single-use and expired by the time upload() resolves, not
// a fetchable link. Optional because the multipart adapter (multipart.ts)
// has no single URL to report — each part had its own.
export type UploadResult = { key: string; url?: string }

// Abstracts "how a file actually gets uploaded" behind one method, so call
// sites (a future dropzone, an attach-file button, etc.) depend on this
// shape rather than on R2/XHR specifics. Swapping the storage backend later
// means writing a new adapter, not touching every call site.
export interface UploadAdapter {
  upload(file: File, options?: UploadOptions): Promise<UploadResult>
}

export type R2UploadAdapterOptions = {
  // Injected rather than hardcoded to a path: minting the presigned URL
  // needs app-specific auth/fetch wiring (cookies, API base URL — see
  // apps/web/src/lib/api-client.ts) that this package doesn't know about.
  // The caller supplies it once an /api/uploads-style endpoint exists
  // server-side; this adapter only owns the "PUT the bytes, report
  // progress, allow cancellation" part.
  getUploadUrl: (req: PresignedUploadRequest) => Promise<PresignedUpload>
  validation?: UploadRules
}

// Cloudflare R2 is S3-compatible: a presigned PUT URL takes the raw file
// body directly, no multipart/form-data envelope (mirrors the presigned GET
// in apps/server/src/lib/storage.ts).
export function createR2UploadAdapter(opts: R2UploadAdapterOptions): UploadAdapter {
  return {
    async upload(file, options) {
      validateFile(file, opts.validation)
      const { url, key } = await opts.getUploadUrl({ filename: file.name, mimeType: file.type, size: file.size })
      await putWithProgress(url, file, options)
      return { key, url }
    },
  }
}

// XMLHttpRequest, not fetch: fetch has no upload-progress event, and
// AbortController alone can't cancel a fetch body stream reliably across
// browsers the way xhr.abort() does.
function putWithProgress(url: string, file: File, options?: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || !options?.onProgress) return
      options.onProgress({ loaded: e.loaded, total: e.total, percent: Math.round((e.loaded / e.total) * 100) })
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`上传失败：${xhr.status} ${xhr.statusText}`))
    }
    xhr.onerror = () => reject(new Error('上传失败：网络错误。'))
    xhr.onabort = () => reject(new DOMException('上传已取消。', 'AbortError'))

    const signal = options?.signal
    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.send(file)
  })
}
