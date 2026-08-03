import { apiFetch, readErrorMessage } from './api-client'

// The raw, already-authorized R2 URL behind an artifact — needed by anything
// that reads the file's bytes with its own HTTP client rather than a browser
// navigation (react-pdf, papaparse, the Microsoft Office viewer's
// server-side fetch). None of those carry our session cookie, so they can't
// hit GET /api/artifacts/:id directly the way an <img>/<video> tag can.
export async function getArtifactRawUrl(id: string): Promise<string> {
  const res = await apiFetch(`/api/artifacts/${id}?raw=1`)
  if (!res.ok) throw new Error(await readErrorMessage(res, '获取文件地址失败。'))
  const data = (await res.json()) as { url: string }
  return data.url
}
