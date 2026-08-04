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
  const res = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings satisfies UpdateAgentSettingsRequest),
  })
  if (!res.ok) return { ok: false, error: await readErrorMessage(res, '保存失败，请重试') }
  const data = (await res.json()) as UpdateAgentSettingsResponse
  return { ok: true, persisted: data.persisted }
}
