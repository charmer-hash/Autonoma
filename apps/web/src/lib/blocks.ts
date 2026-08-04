import { get } from 'lodash-es'
import type { StoredMessage } from '@autonoma/shared'
import type { Block, Group } from '@/types/blocks'
import { parseResult } from '@/lib/format'

// 为一个持久化的会话重建 UI blocks——与 apps/server/src/agent/loop.ts:77-115
// 实时构建同一份历史记录的方式完全一致，所以重新加载的对话
// 与刚运行完的对话渲染效果是一样的。
export function messagesToBlocks(messages: StoredMessage[]): Block[] {
  const toolResultsById = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool') toolResultsById.set(m.tool_call_id, m.content)
  }

  const blocks: Block[] = []
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'tool') continue

    if (m.role === 'user') {
      blocks.push({ kind: 'user', text: m.content })
      continue
    }

    if (m.content) {
      blocks.push({ kind: 'text', text: m.content })
    }
    for (const call of m.tool_calls ?? []) {
      let args: unknown
      try {
        args = JSON.parse(call.function.arguments)
      } catch {
        args = call.function.arguments
      }
      const result = toolResultsById.get(call.id)
      if (call.function.name === 'write_document') {
        blocks.push({
          kind: 'document',
          name: String(get(args, 'name', 'document.md')),
          content: String(get(args, 'content', '')),
        })
        continue
      }

      // export_artifact 的负载（导出文件的 id/mimeType/size）只有在工具
      // 运行之后才存在，所以是从 result 中解析出来的，而不是 args——这
      // 与 write_document 不同，后者的内容是模型自己作为 tool_call 参数写的。
      if (call.function.name === 'export_artifact') {
        const parsed = parseResult<{ ok?: boolean; id?: string; name?: string; mimeType?: string; size?: number }>(result)
        if (parsed?.ok && parsed.id && parsed.name && parsed.mimeType && typeof parsed.size === 'number') {
          blocks.push({ kind: 'artifact', id: parsed.id, name: parsed.name, mimeType: parsed.mimeType, size: parsed.size })
          continue
        }
      }

      blocks.push({ kind: 'tool', id: call.id, name: call.function.name, args, result, status: 'done' })
    }
  }
  return blocks
}

// 把连续的非用户 block 归为一组，使得一整轮的工具调用 + 文本共用同一个
// 头像，就像 Slack/Discord/ChatGPT 对同一发送者的消息进行分组那样。
export function groupBlocks(blocks: Block[]): Group[] {
  const groups: Group[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      groups.push({ role: 'user', text: block.text, attachments: block.attachments })
      continue
    }
    const last = groups[groups.length - 1]
    if (last?.role === 'assistant') {
      last.blocks.push(block)
    } else {
      groups.push({ role: 'assistant', blocks: [block] })
    }
  }
  return groups
}
