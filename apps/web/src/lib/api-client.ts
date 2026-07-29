// Falls back to the deployed Railway backend when VITE_API_URL isn't set at
// build time (Cloudflare Pages env vars have been unreliable here) — local
// dev still overrides this via apps/web/.env's explicit localhost value.
export const API_URL = import.meta.env.VITE_API_URL ?? 'https://server-production-3a61.up.railway.app'

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, { credentials: 'include', ...init })
}

export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null)
  return body?.error ?? fallback
}
