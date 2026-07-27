import type OpenAI from 'openai'
import { CommandExitError, type Sandbox } from 'e2b'

export function createTools(sandbox: Sandbox): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Run a shell command in the sandbox and return its stdout, stderr, and exit code. ' +
          'Use this to run code, install packages, or inspect the filesystem.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute, e.g. "python main.py" or "npm install".',
            },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file in the sandbox, creating parent directories as needed.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write, e.g. "main.py".' },
            content: { type: 'string', description: 'Full file content.' },
          },
          required: ['path', 'content'],
        },
      },
    },
  ]

  const toolHandlers: Record<string, (args: unknown) => Promise<string>> = {
    run_command: async (args) => {
      const command = String((args as { command?: unknown })?.command ?? '')
      try {
        const result = await sandbox.commands.run(command, { timeoutMs: 60_000 })
        return JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
      } catch (error) {
        if (error instanceof CommandExitError) {
          return JSON.stringify({ exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr })
        }
        throw error
      }
    },
    write_file: async (args) => {
      const { path, content } = args as { path?: unknown; content?: unknown }
      await sandbox.files.write(String(path ?? ''), String(content ?? ''))
      return JSON.stringify({ ok: true })
    },
  }

  return { tools, toolHandlers }
}
