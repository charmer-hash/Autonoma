import { useRef } from 'react'
import { LogOut } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { DialogShell } from './DialogShell'

export function ConfirmLogoutDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <DialogShell
      open={open}
      onClose={onCancel}
      variant="compact"
      role="alertdialog"
      labelledBy="logout-confirm-title"
      maxWidthClassName="max-w-sm"
      initialFocusRef={confirmButtonRef}
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
    </DialogShell>
  )
}
