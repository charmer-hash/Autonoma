import type { AgentSettings, AgentSettingsResponse, UpdateAgentSettingsRequest, UpdateAgentSettingsResponse } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'

export async function getAgentSettings(): Promise<AgentSettings> {
  const res = await apiFetch('/api/settings')
  if (!res.ok) throw new Error(await readErrorMessage(res, '加载设置失败，请重试'))
  return (await res.json()) as AgentSettingsResponse
}

export async function updateAgentSettings(
  settings: AgentSettings,
): Promise<{ ok: boolean; persisted?: boolean; error?: string }> {
  // AgentSettingsDialog 的 handleSave 是 `const res = await updateAgentSettings(...)`，
  // 期望这个函数永远 resolve 成 {ok, error} 这个形状、不会 reject——不包
  // 一层 try/catch 的话，apiFetch 遇到网络异常（离线等）直接 reject 会让
  // handleSave 里后续的 setSaveState 永远不执行，保存按钮卡在"保存中…"。
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings satisfies UpdateAgentSettingsRequest),
    })
    if (!res.ok) return { ok: false, error: await readErrorMessage(res, '保存失败，请重试') }
    const data = (await res.json()) as UpdateAgentSettingsResponse
    return { ok: true, persisted: data.persisted }
  } catch {
    return { ok: false, error: '网络连接失败，请检查网络后重试。' }
  }
}
