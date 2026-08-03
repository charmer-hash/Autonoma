import { useMemo } from 'react'
import { CheckCircle2, File as FileIcon, Loader2, Terminal, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { cn } from '@autonoma/ui/lib/utils'
import type { PreviewPanelController } from '@/hooks/usePreviewPanel'
import type { Block } from '@/types/blocks'
import { getArtifactRawUrl } from '@/lib/artifacts-api'
import { getToolResultComponent, TOOL_META, toolSummary } from '@/lib/tool-meta'
import { FilePreview } from './file-preview/FilePreview'

// Mirrors Sidebar.tsx's dual-mode CSS almost exactly, just mirrored to the
// right side: mobile is a fixed-position drawer that slides in via
// translate-x (content underneath never reflows); desktop (md+) is back to
// an in-flow panel whose *width* animates, pushing the chat column instead
// of covering it.
const EASE = 'ease-[cubic-bezier(0.16,1,0.3,1)]'
const PANEL_WIDTH = 'md:w-[440px]'

export function PreviewPanel({ panel, blocks }: { panel: PreviewPanelController; blocks: Block[] }) {
  const { target, collapsed, close } = panel

  // Looked up live, every render — never a captured snapshot. A running
  // tool's block mutates in place as output arrives (see
  // useConsoleSession's finishTool); if this held a copy from whenever the
  // panel opened, the user would watch a frozen snapshot instead of the
  // live result.
  const toolBlock =
    target?.kind === 'tool' ? (blocks.find((b) => b.kind === 'tool' && b.id === target.id) as
        | Extract<Block, { kind: 'tool' }>
        | undefined)
      : undefined
  const artifactBlock =
    target?.kind === 'artifact'
      ? (blocks.find((b) => b.kind === 'artifact' && b.id === target.id) as Extract<Block, { kind: 'artifact' }> | undefined)
      : undefined

  const artifactSource = useMemo(
    () =>
      artifactBlock
        ? { name: artifactBlock.name, mimeType: artifactBlock.mimeType, resolveUrl: () => getArtifactRawUrl(artifactBlock.id) }
        : null,
    [artifactBlock],
  )

  const meta = toolBlock ? TOOL_META[toolBlock.name] : undefined
  const HeaderIcon = toolBlock ? meta?.icon ?? Terminal : FileIcon
  const title = toolBlock ? meta?.label ?? toolBlock.name : artifactBlock?.name ?? ''
  const subtitle = toolBlock ? toolSummary(toolBlock.name, toolBlock.args) : undefined

  return (
    <>
      {/* Mobile-only overlay, same treatment as Sidebar's backdrop — always
          mounted so its fade plays on close too, not just on open. */}
      <div
        aria-hidden
        onClick={close}
        className={cn(
          `fixed inset-0 z-30 bg-black/40 transition-opacity duration-300 md:hidden ${EASE}`,
          collapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      />
      <aside
        className={cn(
          `flex shrink-0 flex-col overflow-hidden border-l bg-card text-foreground transition-transform duration-300 ${EASE}`,
          'fixed inset-y-0 right-0 z-40 w-[88vw] max-w-md',
          collapsed ? 'translate-x-full' : 'translate-x-0',
          `md:static md:z-auto md:translate-x-0 md:transition-[width] md:duration-300 ${EASE}`,
          collapsed ? 'md:w-0 md:border-l-0' : PANEL_WIDTH,
        )}
      >
        <div className="flex min-w-0 items-center gap-2 border-b px-4 py-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <HeaderIcon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title}</div>
            {subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{subtitle}</div>}
          </div>
          {toolBlock &&
            (toolBlock.status === 'running' ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-primary" />
            ))}
          <Button variant="ghost" size="icon-sm" onClick={close} aria-label="关闭面板">
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {toolBlock && <ToolDetail block={toolBlock} />}
          {artifactSource && <FilePreview source={artifactSource} />}
          {!toolBlock && !artifactSource && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              内容已不在当前会话中，可能是切换了会话。
            </p>
          )}
        </div>
      </aside>
    </>
  )
}

function ToolDetail({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const ResultComponent = getToolResultComponent(block.name)
  return <ResultComponent block={block} variant="full" />
}
