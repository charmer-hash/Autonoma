import { useMemo, useRef } from 'react'
import { Download, File as FileIcon, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { useDialogTransition } from '@/hooks/useDialogTransition'
import { API_URL } from '@/lib/api-client'
import { getArtifactRawUrl } from '@/lib/artifacts-api'
import { FilePreview } from './file-preview/FilePreview'

export function FilePreviewDialog({
  file,
  onClose,
}: {
  file: { id: string; name: string; mimeType: string } | null
  onClose: () => void
}) {
  const open = file !== null
  const { shouldRender, backdropRef, cardRef } = useDialogTransition(open, onClose, 'large')
  // 在关闭动画播放期间持续渲染最后一个非空的 file——
  // `file` 本身在关闭时会立刻变为 null，但退场时间线
  // 需要一点时间才会真正卸载（与 DocumentPreviewDialog 的做法一致）。
  const lastFile = useRef(file)
  if (file) lastFile.current = file

  const current = lastFile.current
  // 仅在 artifact id 变化时才重新构建——如果每次渲染都生成新的 resolveUrl，
  // 会导致 FilePreview 不断重新获取预签名 URL。
  const source = useMemo(
    () => (current ? { name: current.name, mimeType: current.mimeType, resolveUrl: () => getArtifactRawUrl(current.id) } : null),
    [current],
  )

  if (!shouldRender || !current || !source) return null

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center p-3 sm:items-center sm:p-8">
      <div ref={backdropRef} className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={current.name}
        className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_32px_80px_-24px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-3">
          <FileIcon className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{current.name}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`下载 ${current.name}`}
            render={<a href={`${API_URL}/api/artifacts/${current.id}`} />}
          >
            <Download className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭预览">
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <FilePreview source={source} />
        </div>
      </div>
    </div>
  )
}
