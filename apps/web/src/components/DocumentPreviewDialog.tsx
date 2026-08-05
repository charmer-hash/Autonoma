import { useRef } from 'react'
import { Download, FileText, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { useDialogTransition } from '@/hooks/useDialogTransition'
import { downloadText } from '@/lib/format'
import { Markdown } from './Markdown'

export function DocumentPreviewDialog({
  doc,
  onClose,
}: {
  doc: { name: string; content: string } | null
  onClose: () => void
}) {
  const open = doc !== null
  const { shouldRender, backdropRef, cardRef } = useDialogTransition(open, onClose, 'large')
  // 在关闭动画播放期间持续渲染最后一个非空的 doc——
  // `doc` 本身在关闭时会立刻变为 null，但退场时间线
  // 需要一点时间才会真正卸载。
  const lastDoc = useRef(doc)
  if (doc) lastDoc.current = doc

  if (!shouldRender || !lastDoc.current) return null
  const { name, content } = lastDoc.current

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center p-3 sm:items-center sm:p-8">
      <div ref={backdropRef} className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_32px_80px_-24px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-3">
          <FileText className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => downloadText(name, content)} aria-label={`下载 ${name}`}>
            <Download className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭预览">
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <Markdown text={content} />
        </div>
      </div>
    </div>
  )
}
