import { Hono } from 'hono'
import type { MultipartCompleteRequest, MultipartCreateRequest, MultipartCreateResponse, MultipartPart, MultipartPartUrlRequest, PresignedUpload, PresignedUploadRequest } from '@autonoma/shared'
import { getOwnerId, requireAuth } from '../auth.js'
import { abortMultipartUpload, completeMultipartUpload, createMultipartUpload, getPresignedPartUploadUrl, getPresignedUploadUrl } from '../lib/storage.js'

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024
export function buildUploadKey(ownerId: string | undefined, filename: string): string {
  const safeName = filename.split(/[/\\]/).pop()?.trim() || 'file'
  return `uploads/${ownerId ?? 'anon'}/${crypto.randomUUID()}/${safeName}`
}
export function ownsUploadKey(key: string, ownerId: string | undefined): boolean { return key.startsWith(`uploads/${ownerId ?? 'anon'}/`) }

export const uploadsRouter = new Hono()
uploadsRouter.post('/', requireAuth, async (c) => {
  const body = await c.req.json<Partial<PresignedUploadRequest>>().catch(() => ({}) as Partial<PresignedUploadRequest>)
  const { filename, mimeType, size } = body
  if (!filename || !mimeType || typeof size !== 'number') return c.json({ error: '缺少 filename / mimeType / size。' }, 400)
  if (size > MAX_UPLOAD_BYTES) return c.json({ error: `文件过大，最大允许 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB。` }, 400)
  const key = buildUploadKey(await getOwnerId(c), filename); const url = await getPresignedUploadUrl(key, mimeType)
  return c.json({ url, key } satisfies PresignedUpload)
})
uploadsRouter.post('/multipart/create', requireAuth, async (c) => {
  const body = await c.req.json<Partial<MultipartCreateRequest>>().catch(() => ({}) as Partial<MultipartCreateRequest>); const { filename, mimeType, size } = body
  if (!filename || !mimeType || typeof size !== 'number') return c.json({ error: '缺少 filename / mimeType / size。' }, 400)
  if (size > MAX_UPLOAD_BYTES) return c.json({ error: `文件过大，最大允许 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB。` }, 400)
  const key = buildUploadKey(await getOwnerId(c), filename); const uploadId = await createMultipartUpload(key, mimeType)
  return c.json({ key, uploadId } satisfies MultipartCreateResponse)
})
uploadsRouter.post('/multipart/part-url', requireAuth, async (c) => { const body = await c.req.json<Partial<MultipartPartUrlRequest>>().catch(() => ({}) as Partial<MultipartPartUrlRequest>); const { key, uploadId, partNumber } = body; if (!key || !uploadId || typeof partNumber !== 'number') return c.json({ error: '缺少 key / uploadId / partNumber。' },400); if (!ownsUploadKey(key, await getOwnerId(c))) return c.json({ error:'无权访问该上传任务。'},403); return c.json({ url: await getPresignedPartUploadUrl(key,uploadId,partNumber) }) })
uploadsRouter.post('/multipart/complete', requireAuth, async (c) => { const body = await c.req.json<Partial<MultipartCompleteRequest>>().catch(() => ({}) as Partial<MultipartCompleteRequest>); const {key,uploadId,parts}=body; if(!key||!uploadId||!Array.isArray(parts)||!parts.length)return c.json({error:'缺少 key / uploadId / parts。'},400); if(!ownsUploadKey(key,await getOwnerId(c)))return c.json({error:'无权访问该上传任务。'},403); await completeMultipartUpload(key,uploadId,parts as MultipartPart[]); return c.json({ok:true}) })
uploadsRouter.post('/multipart/abort', requireAuth, async (c) => { const body=await c.req.json<{key?:string;uploadId?:string}>().catch(() => ({}) as { key?: string; uploadId?: string }); const {key,uploadId}=body; if(!key||!uploadId)return c.json({error:'缺少 key / uploadId。'},400); if(!ownsUploadKey(key,await getOwnerId(c)))return c.json({error:'无权访问该上传任务。'},403); await abortMultipartUpload(key,uploadId); return c.json({ok:true}) })
