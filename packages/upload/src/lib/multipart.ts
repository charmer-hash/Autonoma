import type {
  MultipartCompleteRequest,
  MultipartCreateRequest,
  MultipartCreateResponse,
  MultipartPart,
  MultipartPartUrlRequest,
} from '@autonoma/shared'
import { validateFile, type UploadAdapter, type UploadResult, type UploadRules } from './upload'

// R2/S3 会拒绝任何小于 5MB 的非最后一个分片。
const MIN_PART_BYTES = 5 * 1024 * 1024
const DEFAULT_PART_BYTES = 8 * 1024 * 1024
const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_RETRIES_PER_PART = 3

export type R2MultipartUploadAdapterOptions = {
  // 和 upload.ts 中 R2UploadAdapterOptions 一样的"注入后端调用"思路：
  // 生成这些请求需要应用自身的鉴权/请求配置，而这些不是本包应该知道的。
  // abortUpload 是可选的，但强烈建议提供——如果不提供，取消或失败的
  // 上传会留下孤立的分片，一直计入你的 R2 存储桶账单，直到生命周期
  // 规则把它们清理掉。
  createUpload: (req: MultipartCreateRequest) => Promise<MultipartCreateResponse>
  getPartUrl: (req: MultipartPartUrlRequest) => Promise<{ url: string }>
  completeUpload: (req: MultipartCompleteRequest) => Promise<void>
  abortUpload?: (req: { key: string; uploadId: string }) => Promise<void>
  validation?: UploadRules
  // 必须保持 >= MIN_PART_BYTES；最后一个分片不受此下限约束。
  partSizeBytes?: number
  concurrency?: number
  maxRetriesPerPart?: number
}

// 把文件切成若干分片，直接上传到 R2（每个分片一个预签名 URL，浏览器
// 直连 R2——后端不会经手这些字节，和单次上传适配器一致），再让后端
// 把这些分片拼装起来。暴露的 UploadAdapter 形状和 createR2UploadAdapter
// 完全一样，所以调用方（或 useFileUpload）不需要知道自己拿到的是哪一种。
export function createR2MultipartUploadAdapter(opts: R2MultipartUploadAdapterOptions): UploadAdapter {
  const partSizeBytes = Math.max(opts.partSizeBytes ?? DEFAULT_PART_BYTES, MIN_PART_BYTES)
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const maxRetries = opts.maxRetriesPerPart ?? DEFAULT_MAX_RETRIES_PER_PART

  return {
    async upload(file, options): Promise<UploadResult> {
      validateFile(file, opts.validation)
      const chunks = splitIntoChunks(file, partSizeBytes)
      const { key, uploadId } = await opts.createUpload({ filename: file.name, mimeType: file.type, size: file.size })

      // 与调用方传入的 signal 关联，但一旦有任何一个分片彻底失败，我们
      // 也会自己触发它——反正这次上传最终的 completeUpload 调用注定
      // 会失败，没必要让其他正在进行中的分片继续白白消耗带宽。
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
  // 0 字节的文件也必须恰好有一个（空的）分片——R2 会拒绝以零个分片
  // 完成的分片上传。
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
    // 每次重试都重新生成，而不是复用——在网速慢或不稳定的连接下，
    // 预签名 URL 本身也可能在上传过程中过期。
    const { url } = await ctx.getPartUrl({ key: ctx.key, uploadId: ctx.uploadId, partNumber: index + 1 })
    try {
      return await putPart(url, chunk, ctx.signal, ctx.onPartProgress)
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      if (isAbort || attempt >= ctx.maxRetries) throw err
      ctx.onPartProgress(0) // 这个分片的数据没有传成功——不要把过时的进度继续算在内
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
      // R2/S3 要求在 completeUpload 的分片列表中原样回传这个值。
      // 存储桶的 CORS 配置需要包含 `ExposeHeaders: ["ETag"]`，否则浏览器
      // 会在跨域场景下悄悄读不到它（fetch/XHR 会剥离跨域响应中未列出的
      // 响应头）。
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
