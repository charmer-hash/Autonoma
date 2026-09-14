import type OpenAI from 'openai'
import type { GetSandbox } from '../lazy-sandbox.js'
import { insertArtifact } from '../../db/artifacts.js'
import { uploadArtifact } from '../../lib/storage.js'
import { guessMimeType } from '../../lib/mime.js'

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024 // 20MB

// 把 agent 在沙箱里生成的文件（图表、PDF、xlsx、csv、zip 等）
// 展示为可下载/预览的 artifact。与 write_document 互补：
// 那个工具用于模型自己撰写的 Markdown 文本；这个工具用于模型
// 通过 run_command/write_file 运行代码所产出的二进制/非 Markdown
// 文件。上传的字节内容永远不会再被送回发给 LLM 的对话记录——
// 只有一小段元数据 JSON 会（参见 loop.ts 里对 isArtifact 的处理），
// 这样一张几 MB 的图片就不会在后续每一轮都被重新传给模型。
export function createArtifactTools(
  getSandbox: GetSandbox,
  sessionId: string,
): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'export_artifact',
        description:
          '把沙箱里已经生成好的文件（图片、图表、PDF、Word/Excel/PPT、CSV、zip 等非 Markdown 产物）导出给用户下载/预览。' +
          '先用 run_command/write_file 把文件在沙箱里生成好，再调用这个工具。' +
          '纯文字类的计划/报告/摘要请用 write_document，不要用这个工具。单个文件不能超过 20MB。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '沙箱里的文件路径，例如 "chart.png"。' },
            name: {
              type: 'string',
              description: '展示给用户的文件名，例如 "销量图.png"。不填则使用 path 的文件名部分。',
            },
          },
          required: ['path'],
        },
      },
    },
  ]

  const toolHandlers: Record<string, (args: unknown) => Promise<string>> = {
    export_artifact: async (args) => {
      const sandbox = await getSandbox()
      const { path, name } = args as { path?: unknown; name?: unknown }
      const sandboxPath = String(path ?? '')
      const displayName = typeof name === 'string' && name ? name : (sandboxPath.split('/').pop() ?? sandboxPath)

      let bytes: Uint8Array
      try {
        bytes = await sandbox.files.read(sandboxPath, { format: 'bytes', requestTimeoutMs: 60_000 })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 最常见的原因是路径来自之前某轮沙箱、现在已经失效——
        // 把这一点写清楚，让模型能自我纠正（重新执行生成代码后再重试），
        // 而不是只给用户报一个令人困惑的"文件不存在"。
        const hint = /does not exist|no such file/i.test(message)
          ? '（沙箱可能已经过期，之前轮次生成的文件可能不再存在——如果这个路径是更早的消息里生成的，需要用 run_command/write_file 重新生成一次，再调用 export_artifact。）'
          : ''
        return JSON.stringify({ ok: false, error: `读取文件失败：${message}${hint}` })
      }

      if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
        return JSON.stringify({
          ok: false,
          error: `文件太大（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB），超过 20MB 上限，请压缩或拆分后重试。`,
        })
      }

      const mimeType = guessMimeType(displayName)
      const id = crypto.randomUUID()
      const r2Key = `artifacts/${sessionId}/${id}/${displayName}`

      try {
        await uploadArtifact(r2Key, bytes, mimeType)
      } catch (err) {
        return JSON.stringify({ ok: false, error: `上传失败：${err instanceof Error ? err.message : String(err)}` })
      }

      await insertArtifact({
        id,
        sessionId,
        name: displayName,
        mimeType,
        size: bytes.byteLength,
        r2Key,
      })

      return JSON.stringify({ ok: true, id, name: displayName, mimeType, size: bytes.byteLength })
    },
  }

  return { tools, toolHandlers }
}
