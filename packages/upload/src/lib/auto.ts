import { createR2MultipartUploadAdapter, type R2MultipartUploadAdapterOptions } from './multipart'
import { createR2UploadAdapter, type R2UploadAdapterOptions, type UploadAdapter } from './upload'

// 低于这个阈值时，分片上传额外的往返请求（create/getPartUrl/complete）
// 带来的开销比它节省的还多——一次 PUT 更简单，速度也一样快。这样设置
// 还能从设计上保证每个分片都不小于 R2/S3 要求的 5MB 分片大小下限。
const DEFAULT_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024

export type R2AutoUploadAdapterOptions = {
  single: R2UploadAdapterOptions
  multipart: R2MultipartUploadAdapterOptions
  multipartThresholdBytes?: number
}

// 在调用时按文件大小选择策略：小文件走单次 PUT（upload.ts），大文件则
// 分片（multipart.ts），这样连接不稳定时只需要重试某一个分片，而不是
// 重新上传整个文件，而且多个分片可以并发上传。两种情况下暴露的
// UploadAdapter 形状完全一致，所以组件（或 useFileUpload）永远不需要
// 自己根据文件大小做分支判断——只管调用 upload()，交给这个适配器决定。
export function createR2AutoUploadAdapter(opts: R2AutoUploadAdapterOptions): UploadAdapter {
  const threshold = opts.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES
  const single = createR2UploadAdapter(opts.single)
  const multipart = createR2MultipartUploadAdapter(opts.multipart)

  return {
    upload(file, options) {
      return (file.size > threshold ? multipart : single).upload(file, options)
    },
  }
}
