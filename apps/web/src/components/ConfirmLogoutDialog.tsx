import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { LogOut } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'

export function ConfirmLogoutDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [render, setRender] = useState(open)
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (open) setRender(true)
  }, [open])

  // 进场：在 render 追上已经为 true 的 `open` 之后触发。
  useLayoutEffect(() => {
    if (!render || !open) return
    gsap.set(backdropRef.current, { opacity: 0 })
    gsap.set(cardRef.current, { opacity: 0, y: 8, scale: 0.97 })
    gsap.to(backdropRef.current, { opacity: 1, duration: 0.2, ease: 'power2.out' })
    gsap.to(cardRef.current, { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: 'power3.out' })
    confirmButtonRef.current?.focus()
  }, [render, open])

  // 退场：先播放动画，然后再真正卸载组件。
  useLayoutEffect(() => {
    if (open || !render) return
    const tl = gsap.timeline({ onComplete: () => setRender(false) })
    tl.to(cardRef.current, { opacity: 0, y: 8, scale: 0.97, duration: 0.18, ease: 'power1.in' }, 0)
    tl.to(backdropRef.current, { opacity: 0, duration: 0.18, ease: 'power1.in' }, 0)
    return () => {
      tl.kill()
    }
  }, [open, render])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!render) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div ref={backdropRef} className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-confirm-title"
        className="relative w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <LogOut className="size-4" />
          </div>
          <div className="space-y-1 pt-0.5">
            <h2 id="logout-confirm-title" className="text-sm font-semibold">
              退出登录？
            </h2>
            <p className="text-sm text-muted-foreground">退出后需要重新输入账号密码才能继续使用。</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button ref={confirmButtonRef} onClick={onConfirm}>
            退出登录
          </Button>
        </div>
      </div>
    </div>
  )
}
