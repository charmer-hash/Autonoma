import { apiFetch, readErrorMessage } from './api-client'

export type KnowledgeBase = { id: string; name: string; description: string }
export type KnowledgeDocument = { id: string; filename: string; status: string; errorMessage: string | null; chunkCount: number; pendingVersion: number | null }
export type KnowledgeHit = { ref: string; documentId: string; filename: string; pageNumber: number | null; headingPath: string | null; content: string }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) })
  if (!res.ok) throw new Error(await readErrorMessage(res, `请求失败：${res.status}`))
  return res.json() as Promise<T>
}

export const listBases = () => request<{ bases: KnowledgeBase[] }>('/api/knowledge/bases')
export const createBase = (name: string) => request<{ base: KnowledgeBase }>('/api/knowledge/bases', 'POST', { name })
export const deleteBase = (id: string) => request(`/api/knowledge/bases/${id}`, 'DELETE')
export const listDocuments = (id: string) => request<{ documents: KnowledgeDocument[] }>(`/api/knowledge/bases/${id}/documents`)
export const addDocument = (id: string, key: string, file: File) => request(`/api/knowledge/bases/${id}/documents`, 'POST', { key, filename: file.name, mimeType: file.type || 'application/octet-stream' })
export const replaceDocument = (id: string, key: string, file: File) => request(`/api/knowledge/documents/${id}`, 'PUT', { key, filename: file.name, mimeType: file.type || 'application/octet-stream' })
export const deleteDocument = (id: string) => request(`/api/knowledge/documents/${id}`, 'DELETE')
export const retryDocument = (id: string) => request(`/api/knowledge/documents/${id}/retry`, 'POST')
export const reindexDocument = (id: string) => request(`/api/knowledge/documents/${id}/reindex`, 'POST')
export const searchAllBases = (query: string) => request<{ status: string; sources: KnowledgeHit[]; warning?: string }>('/api/knowledge/search', 'POST', { query })
export const searchBase = (id: string, query: string) => request<{ status: string; sources: KnowledgeHit[]; warning?: string }>(`/api/knowledge/bases/${id}/search`, 'POST', { query })
