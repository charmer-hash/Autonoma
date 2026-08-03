import type OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { insertArtifact } from '../../db/artifacts.js'
import { uploadArtifact } from '../../lib/storage.js'

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024 // 20MB

const EXTENSION_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  md: 'text/markdown',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MIME_TYPES[ext] ?? 'application/octet-stream'
}

// Surfaces a file the agent generated inside its sandbox (chart, PDF, xlsx,
// csv, zip, ...) as a downloadable/previewable artifact. Complements
// write_document: that tool is for Markdown text the model composes itself;
// this one is for binary/non-Markdown files produced by code the model ran
// via run_command/write_file. The uploaded bytes never go back into the
// conversation sent to the LLM — only a small metadata JSON does (see
// loop.ts's isArtifact handling) — so a multi-MB image doesn't get
// re-transmitted to the model on every subsequent turn.
export function createArtifactTools(
  sandbox: Sandbox,
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
      const { path, name } = args as { path?: unknown; name?: unknown }
      const sandboxPath = String(path ?? '')
      const displayName = typeof name === 'string' && name ? name : (sandboxPath.split('/').pop() ?? sandboxPath)

      let bytes: Uint8Array
      try {
        bytes = await sandbox.files.read(sandboxPath, { format: 'bytes', requestTimeoutMs: 60_000 })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // A stale path from an earlier turn's sandbox is the single most
        // common cause of this — spell it out so the model self-corrects
        // (re-run the generating code, then retry) instead of just reporting
        // a confusing "file not found" to the user.
        const hint = /does not exist|no such file/i.test(message)
          ? '（沙箱是每次对话请求新建的，之前轮次生成的文件不会保留到这一轮——如果这个路径是更早的消息里生成的，需要用 run_command/write_file 重新生成一次，再调用 export_artifact。）'
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
