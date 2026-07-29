import { apiFetch, readErrorMessage } from './api-client'

export async function checkAuth(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/auth/me')
    if (!res.ok) return false
    const data = (await res.json()) as { authenticated?: boolean }
    return Boolean(data.authenticated)
  } catch {
    return false
  }
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.ok) return { ok: true }
  return { ok: false, error: await readErrorMessage(res, '登录失败，请重试') }
}

export async function logout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' })
}
