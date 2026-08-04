import { get } from 'lodash-es'
import { FileCode, Search, Terminal } from 'lucide-react'
import type { ComponentType } from 'react'
import type { Block } from '@/types/blocks'
import { JsonFallbackResult } from '@/components/tool-results/JsonFallbackResult'
import { RunCommandResult } from '@/components/tool-results/RunCommandResult'
import { WebSearchResult } from '@/components/tool-results/WebSearchResult'
import { WriteFileResult } from '@/components/tool-results/WriteFileResult'

// 在 ToolCard（内联、紧凑）和 PreviewPanel（右侧、完整）之间共享——
// 由一个地方统一决定"这个工具名对应哪个图标/标签/结果渲染组件"，
// 这样两处展示就不会悄悄地产生分歧。
export const TOOL_META: Record<string, { icon: typeof Terminal; label: string }> = {
  run_command: { icon: Terminal, label: '命令' },
  write_file: { icon: FileCode, label: '文件' },
  web_search: { icon: Search, label: '搜索' },
}

export function toolSummary(name: string, args: unknown): string {
  if (name === 'run_command') return String(get(args, 'command', ''))
  if (name === 'write_file') return String(get(args, 'path', ''))
  if (name === 'web_search') return String(get(args, 'query', ''))
  return name
}

export type ToolResultProps = { block: Extract<Block, { kind: 'tool' }>; variant?: 'compact' | 'full' }

export function getToolResultComponent(name: string): ComponentType<ToolResultProps> {
  if (name === 'run_command') return RunCommandResult
  if (name === 'write_file') return WriteFileResult
  if (name === 'web_search') return WebSearchResult
  return JsonFallbackResult
}
