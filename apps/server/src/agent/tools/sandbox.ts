import type OpenAI from 'openai'
import { CommandExitError, type Sandbox } from 'e2b'

// Code-execution tools, backed by the per-request e2b sandbox — it's killed
// when the request ends, so files written here never reach the user. Use
// write_document (document.ts) for anything the user needs to keep.
export function createSandboxTools(sandbox: Sandbox): {
  tools: OpenAI.Chat.ChatCompletionTool[]
  toolHandlers: Record<string, (args: unknown) => Promise<string>>
} {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          '在沙箱里执行一条 shell 命令，返回标准输出、标准错误和退出码。' +
          '用于运行代码、安装依赖包，或查看文件系统。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令，例如 "python main.py" 或 "npm install"。',
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
        description:
          '把内容写入沙箱里的一个文件，会自动创建所需的父目录。' +
          '用于你即将运行的代码文件——不要用来输出最终交付物（那个用 write_document）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要写入的文件路径，例如 "main.py"。' },
            content: { type: 'string', description: '文件的完整内容。' },
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
