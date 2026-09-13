import { Download, File, Maximize2 } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { useIsMobile } from '@/hooks/useIsMobile'
import type { Block } from '@/types/blocks'
import { API_URL } from '@/lib/api-client'
import { formatBytes } from '@/lib/format'
import { usePanelStore } from '@/store/panelStore'
import { pickPreviewKind } from './file-preview/dispatch'

export function ArtifactCard({ block }: { block: Extract<Block, { kind: 'artifact' }> }) {
  const openPanel = usePanelStore((s) => s.open)
  const isMobile = useIsMobile()
  const url = `${API_URL}/api/artifacts/${block.id}`
  const previewable = pickPreviewKind(block.mimeType, block.name) !== 'unsupported'

  // 右侧面板有足够空间与聊天区并排显示，预览放在那里，不再用弹窗。
  // 移动端暂时不提供放大预览——面板在移动端是全屏抽屉，在预览上再叠
  // 一层覆盖层的交互还没有针对小屏幕设计过，先隐藏掉，不是删掉功能。
  function openPreview() {
    openPanel({ kind: 'artifact', id: block.id })
  }

  if (block.mimeType.startsWith('image/')) {
    return (
      <div className="overflow-hidden rounded-lg border bg-card">
        {isMobile ? (
          <img src={url} alt={block.name} className="max-h-96 w-full object-contain" />
        ) : (
          <button type="button" onClick={openPreview} className="block w-full cursor-zoom-in">
            <img src={url} alt={block.name} className="max-h-96 w-full object-contain" />
          </button>
        )}
        <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{block.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(block.size)}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`下载 ${block.name}`}
            nativeButton={false}
            render={<a href={url} />}
          >
            <Download className="size-4" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <File className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{block.name}</div>
        <div className="text-xs text-muted-foreground">{formatBytes(block.size)}</div>
      </div>
      {previewable && !isMobile && (
        <Button variant="ghost" size="icon-sm" onClick={openPreview} aria-label={`预览 ${block.name}`}>
          <Maximize2 className="size-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label={`下载 ${block.name}`} nativeButton={false} render={<a href={url} download={block.name} />}>
        <Download className="size-4" />
      </Button>
    </div>
  )
}
