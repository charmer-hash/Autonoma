import { get } from 'lodash-es'
import type { StoredMessage } from '@autonoma/shared'
import type { Block, Group, MessageAttachment } from '@/types/blocks'
import { parseResult } from '@/lib/format'

// 从持久化消息里那段纯文本提示（见 apps/server/src/index.ts 的
// attachFilesToSandbox）反解析出文件名列表，只认"上传成功"这一段，
// 失败/体积过大跳过预览的不算——这两种情况本来就没有可展示的内容。
// 这段文案的措辞是唯一的数据来源、没有结构化字段（id/size/mimeType），
// 所以只要后端这句提示文字改了措辞，这里就会悄悄失效（历史消息不再
// 显示附件），不会报错——可以接受，缩略图本身是锦上添花，不是关键功能。
const ATTACHMENT_NOTE_RE = /用户上传了以下文件，已放在沙箱当前目录：([^；）]+)/

function parseAttachmentNote(content: string): MessageAttachment[] | undefined {
  const match = content.match(ATTACHMENT_NOTE_RE)
  if (!match) return undefined
  const filenames = match[1]
    .split('、')
    .map((f) => f.trim())
    .filter(Boolean)
  return filenames.length > 0 ? filenames.map((filename) => ({ filename })) : undefined
}

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
      blocks.push({ kind: 'user', text: m.content, attachments: parseAttachmentNote(m.content) })
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
