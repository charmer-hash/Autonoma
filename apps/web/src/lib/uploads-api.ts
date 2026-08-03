import type {
  MultipartCompleteRequest,
  MultipartCreateRequest,
  MultipartCreateResponse,
  MultipartPartUrlRequest,
  PresignedUpload,
  PresignedUploadRequest,
} from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readErrorMessage(res, `请求失败：${res.status}`))
  return res.json() as Promise<T>
}

export function getUploadUrl(req: PresignedUploadRequest): Promise<PresignedUpload> {
  return postJson('/api/uploads', req)
}

export function createMultipartUpload(req: MultipartCreateRequest): Promise<MultipartCreateResponse> {
  return postJson('/api/uploads/multipart/create', req)
}

export function getMultipartPartUrl(req: MultipartPartUrlRequest): Promise<{ url: string }> {
  return postJson('/api/uploads/multipart/part-url', req)
}

export function completeMultipartUpload(req: MultipartCompleteRequest): Promise<void> {
  return postJson('/api/uploads/multipart/complete', req)
}

export function abortMultipartUpload(req: { key: string; uploadId: string }): Promise<void> {
  return postJson('/api/uploads/multipart/abort', req)
}
