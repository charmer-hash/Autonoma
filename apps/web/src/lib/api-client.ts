
export const API_URL = import.meta.env.VITE_API_URL ?? 'https://api.whiteinte.com'

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, { credentials: 'include', ...init })
}

export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null)
  return body?.error ?? fallback
}
