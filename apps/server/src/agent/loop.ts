import type OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createTools } from './tools/index.js'
import { client, MODEL, VISION_MODEL } from './client.js'
import { buildVisionMessage, type PendingVisionImage } from './tools/vision.js'
import type { AgentEvent } from '@autonoma/shared'

const MAX_TURNS = 30
const MAX_STREAM_RETRIES = 2

// Node 的 fetch（undici）在对端于流式传输中途关闭连接时，
// 会抛出一个裸的 `TypeError: terminated`——这是短暂的网络抖动，
// 不是真正的模型/工具故障，但它的错误信息本身对用户毫无意义。
// 这里用的是宽泛的名字匹配，而非穷举列表——凡是看起来像
// 网络/socket 问题的，都值得静默重试，而不是让整轮对话直接失败。
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
- view_image：用户在当前这轮消息里上传的图片会自动展示给你看，不用调用工具。但图片内容不会保留在更靠后的历史轮次里——如果几轮之后还需要重新确认某张图片（用户上传的，或者自己用代码生成的图表）的具体细节，主动调用 view_image 重新查看一次。

重要约束：沙箱通常会在同一个对话的多轮消息之间保留，但空闲太久会被回收，不保证一定还在。如果对话历史里提到之前生成过某个文件，但你在**当前这一轮**还没有重新执行过生成它的代码，不要假设它还在——先用 run_command 之类的方式确认一下（比如 ls/cat），不存在就用 run_command/write_file 重新生成一遍，再调用 export_artifact，不要直接假设文件还在。

按步骤推进：如果任务涉及真实世界的事实，先调研再行动。完成后用一段简短的文字总结你做了什么，不要再调用任何工具。`

export function createInitialMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [{ role: 'system', content: SYSTEM_PROMPT }]
}

// `messages` 是该会话的完整历史记录（原地修改——这里每次 push
// 都对调用方可见，会话正是靠这个方式记住之前的轮次），新的
// 用户任务已经被追加进去了。如果调用方是一次性调用、不需要
// 持久化会话，直接传 createInitialMessages() 加一条消息即可。
export async function* runAgentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  sandbox: Sandbox,
  sessionId: string,
  initialVisionImages: PendingVisionImage[] = [],
): AsyncGenerator<AgentEvent> {
  // 排队等待展示给模型的图片，*仅*用于下一次 LLM 调用
  // （参见 tools/vision.ts 的 buildVisionMessage）——这里先用本轮
  // 刚上传的附件做初始填充，之后随着循环运行会被 view_image
  // 工具处理器继续追加。这个数组永远不会被 push 进 `messages`，
  // 所以不会被持久化，也不会在后续轮次里重新发送。
  const pendingVisionImages: PendingVisionImage[] = [...initialVisionImages]
  const { tools, toolHandlers } = createTools(sandbox, sessionId, pendingVisionImages)

  // 每次运行都重新计算（而不是写死进持久化的系统提示词里，
  // 那样的话一旦长期存在的会话跨过今天就会过时）——没有这个的话，
  // 模型就无从知道"现在"是什么时候，在措辞搜索关键词时会
  // 默认靠训练数据猜一个年份。
  const dateNote: OpenAI.Chat.ChatCompletionMessageParam = {
    role: 'system',
    content: `今天的日期是 ${new Date().toISOString().slice(0, 10)}。涉及"最新"、"现在"、"今年"等时间相关的表述和搜索关键词时，以这个日期为准，不要依赖训练知识猜测当前年份。`,
  }

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let content = ''
      const toolCalls: OpenAI.Chat.ChatCompletionMessageFunctionToolCall[] = []
      let finishReason: string | null = null

      // 每一轮都根据当前排队的内容重新构建（本轮上传的图片，
      // 或者上一轮 view_image 调用留下的）——只拼接进本次调用的
      // payload，绝不写入 `messages` 本身。模型的选择也遵循同样的
      // 逻辑，让每个纯文本轮次都走便宜的 MODEL，只有真正需要视觉
      // 能力的那一轮才会用支持视觉的模型。
      const visionMessages = buildVisionMessage(pendingVisionImages)
      const modelForThisCall = pendingVisionImages.length > 0 ? VISION_MODEL : MODEL

      // 这里的重试只会从头干净地重新执行一遍 create()+消费流的过程——
      // 只要本轮还没有任何内容送达用户（`yieldedAnything` 为 false），
      // 这样做就是安全的。一旦已经 yield 过任何 text_delta/tool_call，
      // 重试就会导致用户已经看到的内容被重复或悄悄丢失，所以从那时起，
      // 流错误就是真正的失败，不再作为重试的候选。
      for (let attempt = 0; ; attempt++) {
        let yieldedAnything = false
        try {
          const chunkStream = await client.chat.completions.create({
            model: modelForThisCall,
            messages: [messages[0], dateNote, ...messages.slice(1), ...visionMessages],
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

      // 已经送达——清空它，这样只有后续轮次的 view_image 调用
      // 才能为下一次 LLM 调用重新填充这个数组。
      pendingVisionImages.length = 0

      if (finishReason === 'tool_calls' && toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

        for (const toolCall of toolCalls) {
          let args: unknown
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = toolCall.function.arguments
          }

          // write_document 的参数本身就是交付物——把它展示为文档卡片，
          // 而不是普通的工具调用（它的原始 args 其实就是同一份文档，
          // 只是被转成了转义后的 JSON）。export_artifact 仍然会先展示
          // 一张普通的"运行中"工具卡片（因为读取沙箱文件并上传到 R2
          // 需要一点时间），但成功后其结果会被替换成 artifact 卡片，
          // 而不是普通的 tool_result。
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
              // 结果格式错误/是一条错误信息——走到下面通用的
              // tool_result 分支，让这次失败仍然能被看到。
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
