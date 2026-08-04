import type OpenAI from 'openai'
import { FileNotFoundError, type Sandbox } from 'e2b'
import { getLatestAttachmentByFilename } from '../../db/attachments.js'
import { guessMimeType } from '../../lib/mime.js'
import { getObjectBytes, getObjectSize } from '../../lib/storage.js'

export type PendingVisionImage = { mimeType: string; base64: string; label: string }

export const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

// Turns whatever's currently queued up (freshly-uploaded attachments, or a
// view_image tool call from the model itself) into a one-off user message
// to splice into the *next* LLM call's payload only — never pushed into the
// session's persisted `messages`, so image bytes never get written to the
// DB or re-sent on later turns. Mirrors loop.ts's dateNote: computed fresh
// per call, not part of history.
export function buildVisionMessage(images: PendingVisionImage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (images.length === 0) return []

  const content: OpenAI.Chat.ChatCompletionContentPart[] = []
  for (const image of images) {
    content.push({ type: 'text', text: `图片：${image.label}` })
    content.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } })
  }

  return [{ role: 'user', content }]
}

// `pendingVisionImages` is owned by the caller (loop.ts) — the view_image
// handler pushes onto it as a side effect; the tool's actual return value
// (persisted to `messages`) stays a small text acknowledgement, never the
// image bytes themselves.
export function createVisionTools(
  sandbox: Sandbox,
  sessionId: string,
  pendingVisionImages: PendingVisionImage[],
): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'view_image',
        description:
          '重新读取沙箱里的一张图片并"看"一遍它的内容——用于确认之前上传或自己生成的图片/图表细节。' +
          '仅适用于图片文件（png/jpg/jpeg/gif/webp 等），不要用来查看非图片文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '沙箱里的图片文件路径，例如 "photo.jpg" 或 "chart.png"。' },
          },
          required: ['path'],
        },
      },
    },
  ]

  const toolHandlers: Record<string, (args: unknown) => Promise<string>> = {
    view_image: async (args) => {
      const { path } = args as { path?: unknown }
      const filePath = String(path ?? '')
      if (!filePath) return JSON.stringify({ ok: false, error: '缺少 path 参数。' })

      let mimeType = guessMimeType(filePath)
      if (!mimeType.startsWith('image/')) {
        return JSON.stringify({ ok: false, error: `"${filePath}" 看起来不是图片文件，view_image 只能查看图片。` })
      }

      // 先问真实大小、超限就直接拒绝，不要整个读进内存再检查——沙箱
      // 里的文件大小、R2 对象的 ContentLength 都是"实际写入的字节数"，
      // 不像上传时客户端声明的 size 那样可以被随意谎报。
      const tooLarge = (bytes: number) =>
        JSON.stringify({
          ok: false,
          error: `图片太大（${(bytes / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_VISION_IMAGE_BYTES / 1024 / 1024}MB 上限，请先压缩再查看。`,
        })

      let bytes: Uint8Array
      try {
        const info = await sandbox.files.getInfo(filePath, { requestTimeoutMs: 60_000 })
        if (info.size > MAX_VISION_IMAGE_BYTES) return tooLarge(info.size)
        bytes = await sandbox.files.read(filePath, { format: 'bytes', requestTimeoutMs: 60_000 })
      } catch (err) {
        // getInfo/read 对不存在的路径都会抛 e2b SDK 的 FileNotFoundError
        // （见其 FILESYSTEM_HTTP_ERROR_MAP：404 -> FileNotFoundError）——
        // 用类型判断而不是匹配错误文案，两个调用点都可靠。
        if (!(err instanceof FileNotFoundError)) {
          const message = err instanceof Error ? err.message : String(err)
          return JSON.stringify({ ok: false, error: `读取文件失败：${message}` })
        }

        // 沙箱里没有这个文件（大概率是过期了）——回退去查一下这个 session
        // 有没有对应的上传记录，有的话直接从 R2 把原始字节取回来，这样
        // 沙箱过期也不会真的丢图。找不到记录的话说明这确实是沙箱临时
        // 生成过的文件（不是用户上传的），保持原来的报错文案。
        const filename = filePath.split('/').pop() ?? filePath
        const record = await getLatestAttachmentByFilename(sessionId, filename).catch(() => undefined)
        if (!record) {
          return JSON.stringify({
            ok: false,
            error: '（文件不存在——如果这是之前轮次生成的文件，沙箱可能已经过期，需要重新生成一遍再查看。）',
          })
        }

        try {
          const size = await getObjectSize(record.r2Key)
          if (size > MAX_VISION_IMAGE_BYTES) return tooLarge(size)
          bytes = await getObjectBytes(record.r2Key)
        } catch (fetchErr) {
          return JSON.stringify({
            ok: false,
            error: `沙箱文件已过期，从存储恢复也失败了：${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          })
        }
        mimeType = record.mimeType
        // 尽力写回沙箱，方便同一 session 后面 run_command/write_file 也能
        // 用上这份文件——不阻塞、失败也不影响这次已经拿到的图片内容。
        await sandbox.files.write(filePath, new Blob([bytes])).catch(() => {})
      }

      pendingVisionImages.push({ mimeType, base64: Buffer.from(bytes).toString('base64'), label: filePath })
      return JSON.stringify({ ok: true, note: '图片已重新读取，将在下一条消息中看到其内容。' })
    },
  }

  return { tools, toolHandlers }
}
