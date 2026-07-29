const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' })
    if (!res.ok) return false
    const data = (await res.json()) as { authenticated?: boolean }
    return Boolean(data.authenticated)
  } catch {
    return false
  }
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  })
  if (res.ok) return { ok: true }
  const data = await res.json().catch(() => null)
  return { ok: false, error: data?.error ?? '登录失败，请重试' }
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' })
}
