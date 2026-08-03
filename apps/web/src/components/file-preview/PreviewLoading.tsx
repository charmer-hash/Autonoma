import { Loader2 } from 'lucide-react'

export function PreviewLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      加载中…
    </div>
  )
}
