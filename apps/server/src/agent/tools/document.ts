import type OpenAI from 'openai'

// 真正的交付物——内容会直接以 `document` SSE 事件的形式发给前端
// （参见 loop.ts），而不是写入临时的沙箱文件系统，所以请求结束后
// 内容依然存在。
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
