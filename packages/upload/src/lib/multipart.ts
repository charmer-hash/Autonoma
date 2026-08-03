import type {
  MultipartCompleteRequest,
  MultipartCreateRequest,
  MultipartCreateResponse,
  MultipartPart,
  MultipartPartUrlRequest,
} from '@autonoma/shared'
import { validateFile, type UploadAdapter, type UploadResult, type UploadRules } from './upload'

// R2/S3 reject any non-final part smaller than 5MB.
const MIN_PART_BYTES = 5 * 1024 * 1024
const DEFAULT_PART_BYTES = 8 * 1024 * 1024
const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_RETRIES_PER_PART = 3

export type R2MultipartUploadAdapterOptions = {
  // Same "inject the backend calls" reasoning as R2UploadAdapterOptions in
  // upload.ts: minting these needs the app's own auth/fetch wiring, which
  // this package doesn't know about. abortUpload is optional but strongly
  // recommended — without it, a cancelled or failed upload leaves orphaned
  // parts billed against your R2 bucket until a lifecycle rule sweeps them.
  createUpload: (req: MultipartCreateRequest) => Promise<MultipartCreateResponse>
  getPartUrl: (req: MultipartPartUrlRequest) => Promise<{ url: string }>
  completeUpload: (req: MultipartCompleteRequest) => Promise<void>
  abortUpload?: (req: { key: string; uploadId: string }) => Promise<void>
  validation?: UploadRules
  // Must stay >= MIN_PART_BYTES; the last part is exempt from the minimum.
  partSizeBytes?: number
  concurrency?: number
  maxRetriesPerPart?: number
}

// Splits a file into parts, uploads them straight to R2 (one presigned URL
// per part, browser -> R2 direct — the backend never sees the bytes, same
// as the single-shot adapter), then asks the backend to assemble them.
// Exposes the exact same UploadAdapter shape as createR2UploadAdapter, so a
// caller (or useFileUpload) doesn't need to know which one it's holding.
export function createR2MultipartUploadAdapter(opts: R2MultipartUploadAdapterOptions): UploadAdapter {
  const partSizeBytes = Math.max(opts.partSizeBytes ?? DEFAULT_PART_BYTES, MIN_PART_BYTES)
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const maxRetries = opts.maxRetriesPerPart ?? DEFAULT_MAX_RETRIES_PER_PART

  return {
    async upload(file, options): Promise<UploadResult> {
      validateFile(file, opts.validation)
      const chunks = splitIntoChunks(file, partSizeBytes)
      const { key, uploadId } = await opts.createUpload({ filename: file.name, mimeType: file.type, size: file.size })

      // Linked to the caller's signal, but we also trip it ourselves the
      // moment any one part permanently fails — no point letting the other
      // in-flight parts keep burning bandwidth on an upload whose
      // completeUpload call is doomed anyway.
      const internal = new AbortController()
      if (options?.signal?.aborted) internal.abort()
      options?.signal?.addEventListener('abort', () => internal.abort(), { once: true })

      const abortRemote = async () => {
        if (opts.abortUpload) await opts.abortUpload({ key, uploadId }).catch(() => {})
      }

      const loadedByPart = new Array<number>(chunks.length).fill(0)
      const reportProgress = () => {
        if (!options?.onProgress) return
        const loaded = loadedByPart.reduce((a, b) => a + b, 0)
        options.onProgress({ loaded, total: file.size, percent: file.size ? Math.round((loaded / file.size) * 100) : 100 })
      }

      const parts: MultipartPart[] = new Array(chunks.length)
      let next = 0
      let firstError: unknown

      const runWorker = async () => {
        while (next < chunks.length) {
          if (internal.signal.aborted) return
          const i = next++
          try {
            const etag = await uploadPartWithRetry(chunks[i], i, {
              key,
              uploadId,
              getPartUrl: opts.getPartUrl,
              maxRetries,
              signal: internal.signal,
              onPartProgress: (loaded) => {
                loadedByPart[i] = loaded
                reportProgress()
              },
            })
            parts[i] = { partNumber: i + 1, etag }
          } catch (err) {
            firstError ??= err
            internal.abort()
            return
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, runWorker))

      if (firstError) {
        await abortRemote()
        throw firstError
      }
      if (options?.signal?.aborted) {
        await abortRemote()
        throw new DOMException('上传已取消。', 'AbortError')
      }

      try {
        await opts.completeUpload({ key, uploadId, parts })
      } catch (err) {
        await abortRemote()
        throw err
      }

      return { key }
    },
  }
}

function splitIntoChunks(file: File, partSizeBytes: number): Blob[] {
  const chunks: Blob[] = []
  for (let start = 0; start < file.size; start += partSizeBytes) {
    chunks.push(file.slice(start, start + partSizeBytes))
  }
  // A 0-byte file still needs exactly one (empty) part — R2 rejects a
  // multipart upload completed with zero parts.
  return chunks.length > 0 ? chunks : [file.slice(0, 0)]
}

async function uploadPartWithRetry(
  chunk: Blob,
  index: number,
  ctx: {
    key: string
    uploadId: string
    getPartUrl: R2MultipartUploadAdapterOptions['getPartUrl']
    maxRetries: number
    signal: AbortSignal
    onPartProgress: (loaded: number) => void
  },
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    if (ctx.signal.aborted) throw new DOMException('上传已取消。', 'AbortError')
    // Re-minted on every retry, not reused — a presigned URL can itself
    // expire mid-upload on a slow/flaky connection.
    const { url } = await ctx.getPartUrl({ key: ctx.key, uploadId: ctx.uploadId, partNumber: index + 1 })
    try {
      return await putPart(url, chunk, ctx.signal, ctx.onPartProgress)
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      if (isAbort || attempt >= ctx.maxRetries) throw err
      ctx.onPartProgress(0) // this part's bytes didn't land — don't leave stale progress counted in
    }
  }
}

function putPart(url: string, chunk: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`分片上传失败：${xhr.status} ${xhr.statusText}`))
        return
      }
      // R2/S3 must echo this back verbatim in completeUpload's part list.
      // The bucket's CORS config needs `ExposeHeaders: ["ETag"]` or the
      // browser silently can't read it cross-origin (fetch/XHR strip
      // unlisted response headers on cross-origin requests).
      const etag = xhr.getResponseHeader('ETag')
      if (!etag) {
        reject(new Error('分片上传失败：响应缺少 ETag（请检查 R2 桶的 CORS ExposeHeaders 是否包含 ETag）。'))
        return
      }
      onProgress(chunk.size)
      resolve(etag)
    }
    xhr.onerror = () => reject(new Error('分片上传失败：网络错误。'))
    xhr.onabort = () => reject(new DOMException('上传已取消。', 'AbortError'))

    if (signal.aborted) {
      xhr.abort()
      return
    }
    signal.addEventListener('abort', () => xhr.abort(), { once: true })

    xhr.send(chunk)
  })
}
