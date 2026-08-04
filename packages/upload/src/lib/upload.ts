import type { PresignedUpload, PresignedUploadRequest } from '@autonoma/shared'

export type UploadProgress = { loaded: number; total: number; percent: number }

export type UploadRules = {
  // MIME 匹配模式，例如 ['image/*', 'application/pdf']。未定义表示任意类型。
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

// `url` 是当时使用的预签名 PUT URL，回传主要是为了方便调试——它是一次性
// 的，等 upload() resolve 时已经过期了，并不是一个可再次访问的链接。
// 之所以是可选项，是因为分片上传适配器（multipart.ts）没有单一的 URL
// 可以回传——每个分片都有自己的 URL。
export type UploadResult = { key: string; url?: string }

// 把"文件到底是怎么上传的"这件事抽象到一个方法背后，这样调用方（未来的
// 拖拽上传区、附件按钮等）依赖的是这个统一的接口形状，而不是 R2/XHR 的
// 具体实现细节。以后要换存储后端，只需要写一个新的适配器，不用改动每
// 个调用点。
export interface UploadAdapter {
  upload(file: File, options?: UploadOptions): Promise<UploadResult>
}

export type R2UploadAdapterOptions = {
  // 以注入方式传入，而不是写死某个路径：生成预签名 URL 需要应用自身的
  // 鉴权/请求配置（cookies、API 基础地址——见 apps/web/src/lib/api-client.ts），
  // 这些都不是本包应该知道的。等服务端有了类似 /api/uploads 的接口后，
  // 由调用方提供这个函数；这个适配器只负责"PUT 字节数据、上报进度、
  // 支持取消"这部分。
  getUploadUrl: (req: PresignedUploadRequest) => Promise<PresignedUpload>
  validation?: UploadRules
}

// Cloudflare R2 兼容 S3：预签名的 PUT URL 直接接收原始文件内容，不需要
// multipart/form-data 包装（与 apps/server/src/lib/storage.ts 中的预签名
// GET 用法对应）。
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

// 用 XMLHttpRequest 而不是 fetch：fetch 没有上传进度事件，而且单靠
// AbortController 并不能像 xhr.abort() 那样在各浏览器中都可靠地取消
// fetch 的请求体流。
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
