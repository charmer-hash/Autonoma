import type { AuthMeResponse, LoginRequest } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'
import { encryptPassword } from './login-crypto'

export async function checkAuth(): Promise<AuthMeResponse> {
  try {
    const res = await apiFetch('/api/auth/me')
    if (!res.ok) return { authenticated: false }
    const data = (await res.json()) as AuthMeResponse
    return { authenticated: Boolean(data.authenticated), username: data.username }
  } catch {
    return { authenticated: false }
  }
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  let encryptedPassword: string
  try {
    encryptedPassword = await encryptPassword(password)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '加密登录信息失败，请重试' }
  }

  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 线上字段名叫 password，但值是上面加密出来的密文，不是明文——
    // 变量名保留 encryptedPassword 是为了让这段代码本身别把这个事实
    // 弄丢，跟服务端约定的字段名（LoginRequest.password）是两回事。
    body: JSON.stringify({ username, password: encryptedPassword } satisfies LoginRequest),
  })
  if (res.ok) return { ok: true }
  return { ok: false, error: await readErrorMessage(res, '登录失败，请重试') }
}

export async function logout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' })
}
