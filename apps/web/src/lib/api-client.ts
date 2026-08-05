
export const API_URL = import.meta.env.VITE_API_URL ?? 'https://api.whiteinte.com'

// X-Requested-With 是服务端 CSRF 防护要求的自定义请求头（见
// apps/server/src/index.ts），只在会改动状态的请求上校验——GET/HEAD 不
// 需要带，省掉这些请求本来不必要的一次预检往返。这里统一加在 apiFetch
// 里，而不是要求每个调用方自己传，避免漏加。仓库里所有调用方传的
// init.headers 都是纯对象（不是 Headers 实例/数组），直接展开合并即可。
export function apiFetch(path: string, init?: RequestInit) {
  const method = init?.method ?? 'GET'
  const needsCsrfHeader = method !== 'GET' && method !== 'HEAD'
  return fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(needsCsrfHeader ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
}

export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null)
  return body?.error ?? fallback
}
