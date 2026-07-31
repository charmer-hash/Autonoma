import type OpenAI from 'openai'
import { client, MODEL } from './client.js'

// Operational knobs, same convention as OPENROUTER_MODEL — tunable without a
// redeploy since compaction aggressiveness is something you may want to
// adjust after seeing real usage.
const FOLD_TRIGGER_TOKENS = Number(process.env.COMPACTION_TRIGGER_TOKENS ?? 20000)
const KEEP_TAIL_TOKENS = Number(process.env.COMPACTION_KEEP_TOKENS ?? 8000)

// Chars-per-token conversion factor. Content here is a mix of Chinese prose
// (denser than the classic ~4-chars/token English heuristic) and JSON tool
// payloads (English keys/punctuation, closer to 4). 2 is a deliberate
// middle ground that leans toward *over*-estimating — the safe failure
// direction is folding a bit earlier than strictly necessary, not sending
// an oversized payload to the model.
const CHARS_PER_TOKEN = 2

export function estimateTokens(msgs: OpenAI.Chat.ChatCompletionMessageParam[]): number {
  return Math.ceil(JSON.stringify(msgs).length / CHARS_PER_TOKEN)
}

export interface MessageRow {
  id: number
  message: OpenAI.Chat.ChatCompletionMessageParam
}

export interface FoldPlan {
  toFold: MessageRow[]
  keep: MessageRow[]
  cutThroughId: number
}

// Decides whether/where to fold. Only ever cuts immediately before a
// `role: 'user'` message — every real turn starts with one (index.ts always
// pushes it before calling runAgentLoop), which guarantees a cut there can
// never split a tool_calls -> tool pair (OpenAI's hard requirement that a
// `role: 'tool'` message immediately follow the assistant message that
// issued the matching tool_calls), since a user message never appears
// mid-turn.
export function planFold(tailRows: MessageRow[]): FoldPlan | null {
  if (tailRows.length === 0) return null

  const total = estimateTokens(tailRows.map((r) => r.message))
  if (total <= FOLD_TRIGGER_TOKENS) return null

  // Walk backward from the end, accumulating tokens, until we've covered at
  // least KEEP_TAIL_TOKENS worth of the most recent tail.
  let running = 0
  let keepFromIdx = tailRows.length
  while (keepFromIdx > 0 && running < KEEP_TAIL_TOKENS) {
    keepFromIdx--
    running += estimateTokens([tailRows[keepFromIdx].message])
  }

  // Snap backward further to the nearest safe (user-message) boundary.
  while (keepFromIdx > 0 && tailRows[keepFromIdx].message.role !== 'user') {
    keepFromIdx--
  }

  // Nothing safe to fold (e.g. a single oversized first turn) — bail rather
  // than fold zero messages or cut mid-turn.
  if (keepFromIdx === 0) return null

  const toFold = tailRows.slice(0, keepFromIdx)
  const keep = tailRows.slice(keepFromIdx)
  return { toFold, keep, cutThroughId: toFold[toFold.length - 1].id }
}

const MAX_CHARS_PER_TOOL_RESULT = 4000

function serializeForSummaryPrompt(msgs: OpenAI.Chat.ChatCompletionMessageParam[]): string {
  const toolNameById = new Map<string, string>()
  const lines: string[] = []
  for (const m of msgs) {
    if (m.role === 'user') {
      lines.push(`用户：${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    } else if (m.role === 'assistant') {
      if (m.content) lines.push(`助手：${m.content}`)
      for (const tc of m.tool_calls ?? []) {
        if (tc.type === 'function') {
          toolNameById.set(tc.id, tc.function.name)
          lines.push(`助手调用工具 ${tc.function.name}：${tc.function.arguments}`)
        }
      }
    } else if (m.role === 'tool') {
      const name = toolNameById.get(m.tool_call_id) ?? '未知工具'
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const truncated =
        raw.length > MAX_CHARS_PER_TOOL_RESULT ? raw.slice(0, MAX_CHARS_PER_TOOL_RESULT) + '...(已截断)' : raw
      lines.push(`工具结果（${name}）：${truncated}`)
    }
  }
  return lines.join('\n')
}

const SUMMARIZER_SYSTEM_PROMPT =
  '你是对话历史压缩助手。你会收到（1）已有的历史摘要（可能为空）和（2）一段更早的原始对话记录' +
  '（包含用户消息、助手回复、工具调用与工具结果）。请输出一份更新后的完整摘要，用简体中文，尽量精炼' +
  '但保留后续对话中可能用得到的关键信息：用户的目标/偏好/约束、已确认的具体事实（如工具搜索得到的' +
  '价格、地址、日期等）、已完成的任务和产出物（如生成过的文件名、文档标题）、仍待办的事项。直接输出' +
  '摘要正文，不要标题、不要客套话。'

// Calls the LLM once (non-streaming) to fold `toFold` into `existingSummary`.
// Throws on failure — the caller decides how to degrade (loadSessionMessagesForAgent
// falls back to sending the full unfolded tail for this turn).
export async function summarizeFold(
  existingSummary: string | null,
  toFold: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<string> {
  const userContent =
    `已有摘要：\n${existingSummary ?? '（无）'}\n\n` +
    `需要折叠进摘要的原始记录：\n${serializeForSummaryPrompt(toFold)}\n\n` +
    `请输出更新后的完整摘要（覆盖旧摘要，但保留其中仍然重要的信息）。`

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    max_tokens: 1000,
  })

  return res.choices[0]?.message?.content?.trim() || existingSummary || ''
}
