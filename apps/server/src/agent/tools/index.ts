import type OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createSandboxTools } from './sandbox.js'
import { searchTools, searchToolHandlers } from './search.js'
import { documentTools, documentToolHandlers } from './document.js'
import { createArtifactTools } from './artifact.js'

export function createTools(
  sandbox: Sandbox,
  sessionId: string,
): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  const sandboxTools = createSandboxTools(sandbox)
  const artifactTools = createArtifactTools(sandbox, sessionId)
  return {
    tools: [...sandboxTools.tools, ...searchTools, ...documentTools, ...artifactTools.tools],
    toolHandlers: {
      ...sandboxTools.toolHandlers,
      ...searchToolHandlers,
      ...documentToolHandlers,
      ...artifactTools.toolHandlers,
    },
  }
}
