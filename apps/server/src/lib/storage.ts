import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { MultipartPart } from '@autonoma/shared'

// Cloudflare R2 is S3-compatible — same SDK, just a different endpoint/region.
// Client is created lazily (not at module load) so a missing R2 env var only
// breaks the artifact feature, not the whole server's startup.
let client: S3Client | undefined

function getClient(): S3Client {
  if (client) return client
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 未配置（缺少 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）。')
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return client
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET
  if (!bucket) throw new Error('R2 未配置（缺少 R2_BUCKET）。')
  return bucket
}

export async function uploadArtifact(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  await getClient().send(
    new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: bytes, ContentType: mimeType }),
  )
}

// Streams an uploaded file straight from R2 into the sandbox's filesystem
// (sandbox.files.write accepts a ReadableStream) without buffering the whole
// object in the server's memory first — matters once a user attaches
// something sizeable via the multipart path.
export async function getObjectStream(key: string): Promise<ReadableStream<Uint8Array>> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }))
  if (!res.Body) throw new Error('R2 对象为空或不存在。')
  return res.Body.transformToWebStream()
}

// Short-lived (5 min — just long enough for the browser to follow the
// redirect and fetch the object) signed GET URL. `disposition` controls
// whether the browser renders it in place (images) or downloads it.
export async function getPresignedDownloadUrl(
  key: string,
  opts: { filename: string; mimeType: string; disposition: 'inline' | 'attachment' },
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ResponseContentType: opts.mimeType,
    ResponseContentDisposition: `${opts.disposition}; filename="${encodeURIComponent(opts.filename)}"`,
  })
  return getSignedUrl(getClient(), command, { expiresIn: 300 })
}

// Short-lived (5 min — just long enough for the browser to start the PUT
// before the URL expires; the PUT itself isn't cut off mid-flight once
// started) signed PUT URL for a direct-from-browser single-shot upload —
// pairs with @autonoma/upload's createR2UploadAdapter.
export async function getPresignedUploadUrl(key: string, mimeType: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: getBucket(), Key: key, ContentType: mimeType })
  return getSignedUrl(getClient(), command, { expiresIn: 300 })
}

// --- Multipart upload (large files, direct-from-browser) ---
// Pairs with @autonoma/upload's createR2MultipartUploadAdapter: create once,
// getPresignedPartUploadUrl per part, then complete (or abort on
// cancel/failure). Mirrors S3's own multipart API — R2 implements the same
// three calls.

export async function createMultipartUpload(key: string, mimeType: string): Promise<string> {
  const res = await getClient().send(
    new CreateMultipartUploadCommand({ Bucket: getBucket(), Key: key, ContentType: mimeType }),
  )
  if (!res.UploadId) throw new Error('R2 未返回 uploadId。')
  return res.UploadId
}

// Each part gets its own short-lived URL (not one shared URL) since a large
// file's parts can be uploaded well apart in time — one 5-minute window for
// the whole file would expire before slower parts finish.
export async function getPresignedPartUploadUrl(key: string, uploadId: string, partNumber: number): Promise<string> {
  const command = new UploadPartCommand({ Bucket: getBucket(), Key: key, UploadId: uploadId, PartNumber: partNumber })
  return getSignedUrl(getClient(), command, { expiresIn: 300 })
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<void> {
  await getClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: getBucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  )
}

// Best-effort cleanup for a cancelled/failed multipart upload — without
// this, R2 keeps billing the already-uploaded parts of an object that will
// never be completed until a lifecycle rule (if any) sweeps it.
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await getClient().send(new AbortMultipartUploadCommand({ Bucket: getBucket(), Key: key, UploadId: uploadId }))
}
