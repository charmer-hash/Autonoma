import { get } from 'lodash-es'
import type { StoredMessage } from '@autonoma/shared'
import type { Block, Group } from '@/types/blocks'

// Reconstructs the UI blocks for a persisted session — mirrors exactly how
// apps/server/src/agent/loop.ts:77-115 builds the same history live, so a
// reloaded conversation renders identically to one that just finished running.
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
      } else {
        blocks.push({ kind: 'tool', name: call.function.name, args, result, status: 'done' })
      }
    }
  }
  return blocks
}

// Groups consecutive non-user blocks together so a whole turn's tool calls +
// text share one avatar, the way Slack/Discord/ChatGPT group same-sender messages.
export function groupBlocks(blocks: Block[]): Group[] {
  const groups: Group[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      groups.push({ role: 'user', text: block.text })
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
