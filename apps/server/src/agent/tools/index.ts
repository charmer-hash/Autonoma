import type OpenAI from 'openai'
import type { GetSandbox } from '../lazy-sandbox.js'
import { createSandboxTools } from './sandbox.js'
import { searchTools, searchToolHandlers } from './search.js'
import { documentTools, documentToolHandlers } from './document.js'
import { createArtifactTools } from './artifact.js'
import { createVisionTools, type PendingVisionImage } from './vision.js'
import { formatKnowledgeResult, searchKnowledge } from '../../knowledge/search.js'

export function createTools(
  getSandbox: GetSandbox,
  sessionId: string,
  pendingVisionImages: PendingVisionImage[],
  opts: { codeExecEnabled: boolean; webSearchEnabled: boolean; visionEnabled: boolean; knowledgeMode?: 'off' | 'auto' | 'required'; ownerId?: string; knowledgeBaseIds?: string[]; documentIds?: string[] },
): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  // codeExecEnabled 关闭时连带禁用 export_artifact —— 导出文件本质是把
  // 沙箱里跑代码生成的文件导出，没有代码执行几乎不会有文件可导出，两者
  // 作为一个整体的"沙箱能力"开关更符合直觉，也少一个容易配出空转组合的选项。
  const sandboxTools = opts.codeExecEnabled ? createSandboxTools(getSandbox) : undefined
  const artifactTools = opts.codeExecEnabled ? createArtifactTools(getSandbox, sessionId) : undefined
  const visionTools = opts.visionEnabled ? createVisionTools(getSandbox, sessionId, pendingVisionImages) : undefined

  return {
    tools: [
      ...(sandboxTools?.tools ?? []),
      ...(opts.webSearchEnabled ? searchTools : []),
      ...documentTools,
      ...(artifactTools?.tools ?? []),
      ...(visionTools?.tools ?? []),
      ...(opts.knowledgeMode === 'off' ? [] : [{ type: 'function' as const, function: {
        name: 'search_knowledge', description: '检索用户已上传的私有知识库，返回带文档、页码和引用编号的证据。回答内部资料问题时先调用此工具。',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '检索问题或关键词' } }, required: ['query'] },
      } }]),
    ],
    toolHandlers: {
      ...sandboxTools?.toolHandlers,
      ...(opts.webSearchEnabled ? searchToolHandlers : {}),
      ...documentToolHandlers,
      ...artifactTools?.toolHandlers,
      ...visionTools?.toolHandlers,
      ...(opts.knowledgeMode === 'off' ? {} : { search_knowledge: async (args: unknown) => {
        const query = typeof args === 'object' && args !== null && 'query' in args ? String(args.query) : ''
        return formatKnowledgeResult(await searchKnowledge(opts.ownerId, {
          query, knowledgeBaseIds: opts.knowledgeBaseIds, documentIds: opts.documentIds,
        }))
      } }),
    },
  }
}
