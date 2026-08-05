import { useLayoutEffect, useRef } from 'react'
import { LogOut } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { useDialogTransition } from '@/hooks/useDialogTransition'

export function ConfirmLogoutDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { shouldRender, backdropRef, cardRef } = useDialogTransition(open, onCancel, 'compact')
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  // 进场动画播完（`shouldRender` 追上 `open`）之后再把焦点给到确认按钮，
  // 跟原来的行为一致——这一点是这个弹窗特有的，不属于共享 hook 的职责。
  useLayoutEffect(() => {
    if (shouldRender && open) confirmButtonRef.current?.focus()
  }, [shouldRender, open])

  if (!shouldRender) return null

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
