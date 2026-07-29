import type OpenAI from 'openai'

// The actual deliverable — content goes straight to the frontend as a
// `document` SSE event (see loop.ts), not to the ephemeral sandbox
// filesystem, so it's still there after the request ends.
export const documentTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'write_document',
      description:
        '为用户产出最终交付物——计划、报告、行程或摘要——格式为 Markdown。' +
        '这会直接展示给用户并提供下载，不会写入任何文件系统。用于任务真正要求的输出内容，不要用来放代码。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文档标题，例如 "周末出行计划.md"。' },
          content: { type: 'string', description: '完整的文档内容，Markdown 格式。' },
        },
        required: ['name', 'content'],
      },
    },
  },
]

export const documentToolHandlers: Record<string, (args: unknown) => Promise<string>> = {
  write_document: async () => JSON.stringify({ ok: true }),
}
