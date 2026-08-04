import { useState } from 'react'
import { Download, File, Maximize2 } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { useIsMobile } from '@/hooks/useIsMobile'
import type { Block } from '@/types/blocks'
import { API_URL } from '@/lib/api-client'
import { formatBytes } from '@/lib/format'
import { usePanelStore } from '@/store/panelStore'
import { pickPreviewKind } from './file-preview/dispatch'
import { FilePreviewDialog } from './FilePreviewDialog'

export function ArtifactCard({ block }: { block: Extract<Block, { kind: 'artifact' }> }) {
  const openPanel = usePanelStore((s) => s.open)
  const [previewOpen, setPreviewOpen] = useState(false)
  const isMobile = useIsMobile()
  const url = `${API_URL}/api/artifacts/${block.id}`
  const previewable = pickPreviewKind(block.mimeType, block.name) !== 'unsupported'

  // 桌面端：右侧面板有足够空间与聊天区并排显示，所以预览放在那里。
  // 移动端：面板（和 Sidebar 一样）是一个全屏覆盖式抽屉，在预览上再叠一层
  // 覆盖层在小屏幕上会显得多余——所以移动端仍使用居中弹窗展示。
  function openPreview() {
    if (isMobile) setPreviewOpen(true)
    else openPanel({ kind: 'artifact', id: block.id })
  }

  if (block.mimeType.startsWith('image/')) {
    return (
      <>
        <div className="overflow-hidden rounded-lg border bg-card">
          <button type="button" onClick={openPreview} className="block w-full cursor-zoom-in">
            <img src={url} alt={block.name} className="max-h-96 w-full object-contain" />
          </button>
          <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{block.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(block.size)}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`下载 ${block.name}`}
              render={<a href={url} />}
            >
              <Download className="size-4" />
            </Button>
          </div>
        </div>
        <FilePreviewDialog file={previewOpen ? block : null} onClose={() => setPreviewOpen(false)} />
      </>
    )
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <File className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{block.name}</div>
          <div className="text-xs text-muted-foreground">{formatBytes(block.size)}</div>
        </div>
        {previewable && (
          <Button variant="outline" size="sm" onClick={openPreview}>
            <Maximize2 className="size-4" />
            预览
          </Button>
        )}
        <Button variant="outline" size="sm" render={<a href={url} />}>
          <Download className="size-4" />
          下载
        </Button>
      </div>
      <FilePreviewDialog file={previewOpen ? block : null} onClose={() => setPreviewOpen(false)} />
    </>
  )
}
