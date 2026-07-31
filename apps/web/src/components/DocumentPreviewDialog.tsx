import { useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { Download, FileText, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
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
  const [render, setRender] = useState(open)
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // Keeps rendering the last non-null doc while the close animation plays —
  // `doc` itself goes null immediately on close, but the exit timeline
  // needs a moment before unmounting.
  const lastDoc = useRef(doc)
  if (doc) lastDoc.current = doc

  useLayoutEffect(() => {
    if (open) setRender(true)
  }, [open])

  useLayoutEffect(() => {
    if (!render || !open) return
    gsap.set(backdropRef.current, { opacity: 0 })
    gsap.set(cardRef.current, { opacity: 0, y: 16, scale: 0.98 })
    gsap.to(backdropRef.current, { opacity: 1, duration: 0.2, ease: 'power2.out' })
    gsap.to(cardRef.current, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power3.out' })
  }, [render, open])

  useLayoutEffect(() => {
    if (open || !render) return
    const tl = gsap.timeline({ onComplete: () => setRender(false) })
    tl.to(cardRef.current, { opacity: 0, y: 16, scale: 0.98, duration: 0.2, ease: 'power1.in' }, 0)
    tl.to(backdropRef.current, { opacity: 0, duration: 0.2, ease: 'power1.in' }, 0)
    return () => {
      tl.kill()
    }
  }, [open, render])

  useLayoutEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!render || !lastDoc.current) return null
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
