import { Download, File } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import type { Block } from '@/types/blocks'
import { API_URL } from '@/lib/api-client'
import { formatBytes } from '@/lib/format'

export function ArtifactCard({ block }: { block: Extract<Block, { kind: 'artifact' }> }) {
  const url = `${API_URL}/api/artifacts/${block.id}`

  if (block.mimeType.startsWith('image/')) {
    return (
      <div className="overflow-hidden rounded-lg border bg-card">
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={block.name} className="max-h-96 w-full object-contain" />
        </a>
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
      <Button variant="outline" size="sm" render={<a href={url} />}>
        <Download className="size-4" />
        下载
      </Button>
    </div>
  )
}
