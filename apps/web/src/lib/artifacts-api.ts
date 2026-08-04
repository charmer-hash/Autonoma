import { apiFetch, readErrorMessage } from './api-client'

// artifact 背后那个原始的、已经授权好的 R2 URL——供任何用自己的 HTTP
// 客户端（而非浏览器导航）读取文件字节的场景使用（react-pdf、papaparse、
// Microsoft Office 在线预览的服务端 fetch）。这些场景都不会携带我们的
// session cookie，所以它们无法像 <img>/<video> 标签那样直接请求
// GET /api/artifacts/:id。
export async function getArtifactRawUrl(id: string): Promise<string> {
  const res = await apiFetch(`/api/artifacts/${id}?raw=1`)
  if (!res.ok) throw new Error(await readErrorMessage(res, '获取文件地址失败。'))
  const data = (await res.json()) as { url: string }
  return data.url
}
