import { createR2MultipartUploadAdapter, type R2MultipartUploadAdapterOptions } from './multipart'
import { createR2UploadAdapter, type R2UploadAdapterOptions, type UploadAdapter } from './upload'

// Below this, multipart's extra round-trips (create/getPartUrl/complete)
// cost more than they save — one PUT is simpler and just as fast. Also
// keeps every part at or above R2/S3's 5MB part-size floor by construction.
const DEFAULT_MULTIPART_THRESHOLD_BYTES = 20 * 1024 * 1024

export type R2AutoUploadAdapterOptions = {
  single: R2UploadAdapterOptions
  multipart: R2MultipartUploadAdapterOptions
  multipartThresholdBytes?: number
}

// Picks a strategy per file, at call time: small files go through one PUT
// (upload.ts), large ones get chunked (multipart.ts) so a flaky connection
// only has to retry one part instead of restarting the whole transfer, and
// several parts can upload concurrently. Same UploadAdapter shape either
// way, so a component (or useFileUpload) never needs to branch on file size
// itself — just call upload() and let this adapter decide.
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
