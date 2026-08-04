import type OpenAI from 'openai'
import { client, MODEL } from './client.js'

// 运维层面的可调参数，约定与 OPENROUTER_MODEL 相同——无需重新部署即可调整，
// 因为压缩的激进程度是那种需要观察真实使用情况后再调整的东西。
const FOLD_TRIGGER_TOKENS = Number(process.env.COMPACTION_TRIGGER_TOKENS ?? 20000)
const KEEP_TAIL_TOKENS = Number(process.env.COMPACTION_KEEP_TOKENS ?? 8000)

// 字符数换算 token 数的系数。这里的内容混合了中文文本
// （比经典的英文 ~4 字符/token 经验值更密）和 JSON 格式的工具
// 调用数据（英文键名/标点，更接近 4）。选择 2 是刻意取一个
// 偏向*高估*的折中值——安全的失败方向是提前一点折叠，
// 而不是把过大的内容发给模型。
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

// 决定是否/在哪里折叠。只会在紧邻某条 `role: 'user'` 消息之前切割——
// 每一轮真实对话都以一条用户消息开始（index.ts 在调用 runAgentLoop
// 之前总会先 push 一条），这保证了在此处切割永远不会拆散
// tool_calls -> tool 这一对（OpenAI 的硬性要求是 `role: 'tool'`
// 消息必须紧跟在发出对应 tool_calls 的 assistant 消息之后），
// 因为用户消息不会出现在一轮对话的中途。
export function planFold(tailRows: MessageRow[]): FoldPlan | null {
  if (tailRows.length === 0) return null

  const total = estimateTokens(tailRows.map((r) => r.message))
  if (total <= FOLD_TRIGGER_TOKENS) return null

  // 从末尾往前遍历，累加 token 数，直到覆盖了最近的至少
  // KEEP_TAIL_TOKENS 那么多的尾部内容。
  let running = 0
  let keepFromIdx = tailRows.length
  while (keepFromIdx > 0 && running < KEEP_TAIL_TOKENS) {
    keepFromIdx--
    running += estimateTokens([tailRows[keepFromIdx].message])
  }

  // 继续往前回退，直到最近的安全（用户消息）边界。
  while (keepFromIdx > 0 && tailRows[keepFromIdx].message.role !== 'user') {
    keepFromIdx--
  }

  // 没有可以安全折叠的内容（例如第一轮就超大）——直接放弃，
  // 而不是折叠零条消息或在一轮对话中途切割。
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

// 调用一次 LLM（非流式），把 `toFold` 折叠进 `existingSummary`。
// 失败时抛出异常——由调用方决定如何降级处理（loadSessionMessagesForAgent
// 会退化为本轮发送完整的、未折叠的尾部内容）。
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
