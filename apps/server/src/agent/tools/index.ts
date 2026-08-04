import type OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createSandboxTools } from './sandbox.js'
import { searchTools, searchToolHandlers } from './search.js'
import { documentTools, documentToolHandlers } from './document.js'
import { createArtifactTools } from './artifact.js'
import { createVisionTools, type PendingVisionImage } from './vision.js'

export function createTools(
  sandbox: Sandbox,
  sessionId: string,
  pendingVisionImages: PendingVisionImage[],
  opts: { codeExecEnabled: boolean; webSearchEnabled: boolean; visionEnabled: boolean },
): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  // codeExecEnabled 关闭时连带禁用 export_artifact —— 导出文件本质是把
  // 沙箱里跑代码生成的文件导出，没有代码执行几乎不会有文件可导出，两者
  // 作为一个整体的"沙箱能力"开关更符合直觉，也少一个容易配出空转组合的选项。
  const sandboxTools = opts.codeExecEnabled ? createSandboxTools(sandbox) : undefined
  const artifactTools = opts.codeExecEnabled ? createArtifactTools(sandbox, sessionId) : undefined
  const visionTools = opts.visionEnabled ? createVisionTools(sandbox, sessionId, pendingVisionImages) : undefined

  return {
    tools: [
      ...(sandboxTools?.tools ?? []),
      ...(opts.webSearchEnabled ? searchTools : []),
      ...documentTools,
      ...(artifactTools?.tools ?? []),
      ...(visionTools?.tools ?? []),
    ],
    toolHandlers: {
      ...sandboxTools?.toolHandlers,
      ...(opts.webSearchEnabled ? searchToolHandlers : {}),
      ...documentToolHandlers,
      ...artifactTools?.toolHandlers,
      ...visionTools?.toolHandlers,
    },
  }
}
