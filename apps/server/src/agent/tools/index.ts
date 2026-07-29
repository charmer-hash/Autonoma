import type OpenAI from 'openai'
import type { Sandbox } from 'e2b'
import { createSandboxTools } from './sandbox.js'
import { searchTools, searchToolHandlers } from './search.js'
import { documentTools, documentToolHandlers } from './document.js'

export function createTools(sandbox: Sandbox): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  const sandboxTools = createSandboxTools(sandbox)
  return {
    tools: [...sandboxTools.tools, ...searchTools, ...documentTools],
    toolHandlers: {
      ...sandboxTools.toolHandlers,
      ...searchToolHandlers,
      ...documentToolHandlers,
    },
  }
}
