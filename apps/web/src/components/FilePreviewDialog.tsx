import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { Download, File as FileIcon, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
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
  const [render, setRender] = useState(open)
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // Keeps rendering the last non-null file while the close animation plays —
  // `file` itself goes null immediately on close, but the exit timeline
  // needs a moment before unmounting (mirrors DocumentPreviewDialog).
  const lastFile = useRef(file)
  if (file) lastFile.current = file

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

  const current = lastFile.current
  // Rebuilt only when the artifact id changes — a fresh resolveUrl on every
  // re-render would make FilePreview refetch the presigned URL constantly.
  const source = useMemo(
    () => (current ? { name: current.name, mimeType: current.mimeType, resolveUrl: () => getArtifactRawUrl(current.id) } : null),
    [current],
  )

  if (!render || !current || !source) return null

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
