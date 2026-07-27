import OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createTools } from './tools.js'
import type { AgentEvent } from '@autonoma/shared'

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

// Some models get rate-limited or de-listed on OpenRouter without notice —
// keep this an env var so swapping models doesn't need a code change.
const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro'
const MAX_TURNS = 30

const SYSTEM_PROMPT = `You are a coding agent running in a sandboxed Linux VM.
Use the run_command tool to execute shell commands and the write_file tool to create or edit files.
Work step by step: write code, run it, read the output, and fix issues until the task is done.
When you are finished, reply with plain text summarizing what you did and make no further tool calls.`

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
          yield { type: 'tool_call', name: toolCall.function.name, args }

          let result: string
          try {
            const handler = toolHandlers[toolCall.function.name]
            result = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`
          } catch (err) {
            result = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
          }

          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
          yield { type: 'tool_result', name: toolCall.function.name, result }
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
