import OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createTools } from './tools/index.js'
import type { AgentEvent } from '@autonoma/shared'

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

// Some models get rate-limited or de-listed on OpenRouter without notice —
// keep this an env var so swapping models doesn't need a code change.
const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro'
const MAX_TURNS = 30

const SYSTEM_PROMPT = `你是一个通用型 Agent，能够做调研、制定计划、撰写文档，并在沙箱化的 Linux 虚拟机里运行代码。

可用工具：
- web_search：查询实时的真实世界信息。凡是你不确定的具体事实——人名、价格、地址、电话号码、日期、营业时间等——在陈述之前必须先用这个工具查证。绝不能编造具体事实；如果查不到，就如实告诉用户查不到。
- write_document：以 Markdown 格式产出最终交付物（计划、报告、行程、摘要等）。任务真正要求的输出内容用这个工具，它会展示给用户并提供下载。
- run_command / write_file：任务需要写代码、跑代码时，在沙箱里读写文件、执行命令。这里写的文件用户看不到——用户需要保留的内容要用 write_document。

按步骤推进：如果任务涉及真实世界的事实，先调研再行动。完成后用一段简短的文字总结你做了什么，不要再调用任何工具。`

export async function* runAgentLoop(task: string, sandbox: Sandbox): AsyncGenerator<AgentEvent> {
  const { tools, toolHandlers } = createTools(sandbox)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ]

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const chunkStream = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
        stream: true,
      })

      let content = ''
      const toolCalls: OpenAI.Chat.ChatCompletionMessageFunctionToolCall[] = []
      let finishReason: string | null = null

      for await (const chunk of chunkStream) {
        const delta = chunk.choices[0]?.delta
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason
        }

        if (delta?.content) {
          content += delta.content
          yield { type: 'text_delta', delta: delta.content }
        }

        if (delta?.tool_calls) {
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
          // just be the same document dumped as escaped JSON).
          const isDocument = toolCall.function.name === 'write_document'
          if (!isDocument) {
            yield { type: 'tool_call', name: toolCall.function.name, args }
          }

          let result: string
          try {
            const handler = toolHandlers[toolCall.function.name]
            result = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`
          } catch (err) {
            result = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
          }

          if (isDocument) {
            const { name, content } = args as { name?: unknown; content?: unknown }
            yield {
              type: 'document',
              name: typeof name === 'string' ? name : 'document.md',
              content: typeof content === 'string' ? content : '',
            }
          } else {
            yield { type: 'tool_result', name: toolCall.function.name, result }
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
