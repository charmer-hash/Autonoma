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

// Cloudflare R2 兼容 S3 —— 用的是同一套 SDK，只是 endpoint/region 不同。
// 客户端是惰性创建的（而不是在模块加载时创建），这样即使 R2 相关环境变量
// 缺失，也只会导致 artifact 功能不可用，不会影响整个服务器的启动。
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

// 把一个已上传的文件直接从 R2 流式传输进沙箱文件系统
// （sandbox.files.write 接受 ReadableStream），不需要先把整个对象
// 缓冲进服务器内存 —— 一旦用户通过分片上传路径附加了较大的文件，
// 这一点就很重要。
export async function getObjectStream(key: string): Promise<ReadableStream<Uint8Array>> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }))
  if (!res.Body) throw new Error('R2 对象为空或不存在。')
  return res.Body.transformToWebStream()
}

// 短时效（5 分钟 —— 刚好够浏览器跟随重定向并抓取该对象）的
// 签名 GET URL。`disposition` 控制浏览器是原地渲染
// （比如图片）还是直接下载。
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

// 短时效（5 分钟 —— 刚好够浏览器在 URL 过期前发起 PUT 请求；
// 一旦 PUT 已经开始，其本身不会被中途截断）的签名 PUT URL，
// 用于从浏览器直接发起的一次性上传 ——
// 与 @autonoma/upload 的 createR2UploadAdapter 配套使用。
export async function getPresignedUploadUrl(key: string, mimeType: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: getBucket(), Key: key, ContentType: mimeType })
  return getSignedUrl(getClient(), command, { expiresIn: 300 })
}

// --- 分片上传（大文件，从浏览器直接发起）---
// 与 @autonoma/upload 的 createR2MultipartUploadAdapter 配套使用：
// 先 create 一次，每个分片调用一次 getPresignedPartUploadUrl，
// 然后 complete（或在取消/失败时 abort）。这镜像了 S3 自身的
// 分片上传 API —— R2 实现了同样的三个调用。

export async function createMultipartUpload(key: string, mimeType: string): Promise<string> {
  const res = await getClient().send(
    new CreateMultipartUploadCommand({ Bucket: getBucket(), Key: key, ContentType: mimeType }),
  )
  if (!res.UploadId) throw new Error('R2 未返回 uploadId。')
  return res.UploadId
}

// 每个分片都有各自独立的短时效 URL（而不是共用一个 URL），
// 因为一个大文件的各个分片可能在时间上相隔很远才上传 ——
// 给整个文件用一个 5 分钟的窗口，会在较慢的分片完成之前就过期。
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

// 对已取消/失败的分片上传进行尽力而为的清理 —— 如果不这样做，
// R2 会一直为那些永远不会完成的对象已上传的分片计费，
// 直到某条生命周期规则（如果配置了的话）将其清除为止。
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await getClient().send(new AbortMultipartUploadCommand({ Bucket: getBucket(), Key: key, UploadId: uploadId }))
}
