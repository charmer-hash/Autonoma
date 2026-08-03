import type OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createTools } from './tools/index.js'
import { client, MODEL } from './client.js'
import type { AgentEvent } from '@autonoma/shared'

const MAX_TURNS = 30
const MAX_STREAM_RETRIES = 2

// Node's fetch (undici) throws a bare `TypeError: terminated` when the
// remote end closes the connection mid-stream — a transient network blip,
// not a real model/tool failure, but its message alone is meaningless to a
// user. Broad name match, not an exhaustive list — anything network/socket
// shaped is worth a silent retry rather than failing the whole turn.
function isTransientStreamError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /terminated|ECONNRESET|EPIPE|ETIMEDOUT|fetch failed|socket hang up|network/i.test(message)
}

const SYSTEM_PROMPT = `你是一个通用型 Agent，能够做调研、制定计划、撰写文档，并在沙箱化的 Linux 虚拟机里运行代码。

可用工具：
- web_search：查询实时的真实世界信息。凡是你不确定的具体事实——人名、价格、地址、电话号码、日期、营业时间等——在陈述之前必须先用这个工具查证。绝不能编造具体事实；如果查不到，就如实告诉用户查不到。
- write_document：以 Markdown 格式产出最终交付物（计划、报告、行程、摘要等）。任务真正要求的输出内容用这个工具，它会展示给用户并提供下载。
- run_command / write_file：任务需要写代码、跑代码时，在沙箱里读写文件、执行命令。这里写的文件用户看不到——用户需要保留的内容要用 write_document。
- export_artifact：任务需要产出图片、图表、PDF、Excel、CSV、zip 等非 Markdown 文件时，先用 run_command/write_file 在沙箱里把文件生成好，再调用这个工具把它导出给用户下载/预览。生成好之后必须**立刻**调用 export_artifact，不要先写总结文字——万一后续被打断，文件就永远交付不出去了。

重要约束：沙箱通常会在同一个对话的多轮消息之间保留，但空闲太久会被回收，不保证一定还在。如果对话历史里提到之前生成过某个文件，但你在**当前这一轮**还没有重新执行过生成它的代码，不要假设它还在——先用 run_command 之类的方式确认一下（比如 ls/cat），不存在就用 run_command/write_file 重新生成一遍，再调用 export_artifact，不要直接假设文件还在。

按步骤推进：如果任务涉及真实世界的事实，先调研再行动。完成后用一段简短的文字总结你做了什么，不要再调用任何工具。`

export function createInitialMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [{ role: 'system', content: SYSTEM_PROMPT }]
}

// `messages` is the session's full history (mutated in place — every push
// here is visible to the caller, which is how a session remembers past
// turns) with the new user task already appended. A one-off caller with no
// session to persist can just pass createInitialMessages() plus one message.
export async function* runAgentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  sandbox: Sandbox,
  sessionId: string,
): AsyncGenerator<AgentEvent> {
  const { tools, toolHandlers } = createTools(sandbox, sessionId)

  // Computed fresh per run (not baked into the persisted system prompt,
  // which would go stale the moment a long-lived session continues past
  // today) — without this the model has no way to know "now" and defaults
  // to guessing a year from its training data when phrasing search queries.
  const dateNote: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'system',
    content: `今天的日期是 ${new Date().toISOString().slice(0, 10)}。涉及"最新"、"现在"、"今年"等时间相关的表述和搜索关键词时，以这个日期为准，不要依赖训练知识猜测当前年份。`,
  }

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let content = ''
      const toolCalls: OpenAI.Chat.ChatCompletionMessageFunctionToolCall[] = []
      let finishReason: string | null = null

      // A retry here only ever re-runs the create()+stream-consume from a
      // clean slate — safe exactly as long as nothing from this turn has
      // reached the user yet (`yieldedAnything` false). The moment any
      // text_delta/tool_call has been yielded, a retry would either
      // duplicate or silently drop what the user already saw, so from then
      // on a stream error is a real failure, not a retry candidate.
      for (let attempt = 0; ; attempt++) {
        let yieldedAnything = false
        try {
          const chunkStream = await client.chat.completions.create({
            model: MODEL,
            messages: [messages[0], dateNote, ...messages.slice(1)],
            tools,
            stream: true,
          })

          for await (const chunk of chunkStream) {
            const delta = chunk.choices[0]?.delta
            if (chunk.choices[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason
            }

            if (delta?.content) {
              content += delta.content
              yieldedAnything = true
              yield { type: 'text_delta', delta: delta.content }
            }

            if (delta?.tool_calls) {
              yieldedAnything = true
              for (const tc of delta.tool_calls) {
                toolCalls[tc.index] ??= {
                  id: '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                }
                if (tc.id) toolCalls[tc.index].id += tc.id
                if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments
              }
            }
          }
          break
        } catch (err) {
          if (!yieldedAnything && attempt < MAX_STREAM_RETRIES && isTransientStreamError(err)) {
            continue
          }
          throw new Error(
            yieldedAnything
              ? '与模型服务的连接意外中断（网络波动），上面这段回复可能不完整——请重新发送消息继续。'
              : isTransientStreamError(err)
                ? '与模型服务的连接暂时不稳定，请重试。'
                : err instanceof Error
                  ? err.message
                  : String(err),
          )
        }
      }

      if (finishReason === 'tool_calls' && toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

        for (const toolCall of toolCalls) {
          let args: unknown
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = toolCall.function.arguments
          }

          // write_document's payload is the deliverable itself — show it as a
          // document card instead of a generic tool call (its raw args would
          // just be the same document dumped as escaped JSON). export_artifact
          // still shows a normal running tool card first (reading the sandbox
          // file + uploading to R2 takes a moment), but on success its result
          // is swapped for an artifact card instead of a generic tool_result.
          const isDocument = toolCall.function.name === 'write_document'
          const isArtifact = toolCall.function.name === 'export_artifact'
          if (!isDocument) {
            yield { type: 'tool_call', id: toolCall.id, name: toolCall.function.name, args }
          }

          let result: string
          try {
            const handler = toolHandlers[toolCall.function.name]
            result = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`
          } catch (err) {
            result = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
          }

          let artifactEvent: Extract<AgentEvent, { type: 'artifact' }> | undefined
          if (isArtifact) {
            try {
              const parsed = JSON.parse(result) as { ok?: boolean; id?: string; name?: string; mimeType?: string; size?: number }
              if (parsed.ok && parsed.id && parsed.name && parsed.mimeType && typeof parsed.size === 'number') {
                artifactEvent = { type: 'artifact', id: parsed.id, name: parsed.name, mimeType: parsed.mimeType, size: parsed.size }
              }
            } catch {
              // Malformed/error result — falls through to the generic
              // tool_result path below so the failure is still visible.
            }
          }

          if (isDocument) {
            const { name, content } = args as { name?: unknown; content?: unknown }
            yield {
              type: 'document',
              name: typeof name === 'string' ? name : 'document.md',
              content: typeof content === 'string' ? content : '',
            }
          } else if (artifactEvent) {
            yield artifactEvent
          } else {
            yield { type: 'tool_result', id: toolCall.id, name: toolCall.function.name, result }
          }

          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
        }
        continue
      }

      messages.push({ role: 'assistant', content })
      yield { type: 'done' }
      return
    }

    yield { type: 'error', message: `Stopped after ${MAX_TURNS} turns without finishing.` }
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
