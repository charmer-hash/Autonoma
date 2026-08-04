import { memo, useState } from 'react'
import { CircleAlert, Download, FileText, Maximize2 } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import type { Block } from '@/types/blocks'
import { downloadText } from '@/lib/format'
import { ArtifactCard } from './ArtifactCard'
import { DocumentPreviewDialog } from './DocumentPreviewDialog'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'

// 一轮流式回复中每个 token delta 都会让 consoleStore 里的 `blocks`
// 数组产生新引用（见 store/consoleStore.ts 的 appendText），进而让
// MessageList 重新渲染；但除了正在流式输出的最后一个 block，其余历史
// block 对象引用本身是不变的（appendText 只替换数组最后一项）。记忆化后，
// 这些历史 block 就不会跟着每个 delta 一起重新渲染/重新解析 Markdown。
// panel 不再作为 prop 传入——ToolCard/ArtifactCard 各自直接从
// panelStore 取用，这里不需要中转。
export const BlockView = memo(function BlockView({
  block,
  live,
}: {
  block: Exclude<Block, { kind: 'user' }>
  live?: boolean
}) {
  const [previewOpen, setPreviewOpen] = useState(false)

  if (block.kind === 'text') {
    if (live) {
      // 流式输出时使用纯文本，这样光标能内联显示在末尾——
      // 一旦本轮结束，这个 block 会改用 Markdown 重新渲染。
      return (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {block.text}
          {/* 使用真实字形而非固定尺寸的方块——它会继承文本自身的基线
              和行高，因此无论字体或缩放比例如何都能对齐。 */}
          <span className="animate-pulse text-primary">▍</span>
        </p>
      )
    }
    return <Markdown text={block.text} />
  }

  if (block.kind === 'document') {
    return (
      <>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <FileText className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{block.name}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPreviewOpen(true)}
              aria-label={`全屏预览 ${block.name}`}
            >
              <Maximize2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => downloadText(block.name, block.content)}
              aria-label={`下载 ${block.name}`}
            >
              <Download className="size-4" />
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto px-4 py-3">
            <Markdown text={block.content} />
          </div>
        </div>
        <DocumentPreviewDialog
          doc={previewOpen ? { name: block.name, content: block.content } : null}
          onClose={() => setPreviewOpen(false)}
        />
      </>
    )
  }

  if (block.kind === 'artifact') {
    return <ArtifactCard block={block} />
  }

  if (block.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{block.text}</span>
      </div>
    )
  }

  return <ToolCard block={block} />
})
