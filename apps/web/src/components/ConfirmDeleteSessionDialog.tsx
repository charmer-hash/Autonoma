import { useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { DialogShell } from './DialogShell'

// 跟 ConfirmLogoutDialog 是同一类"危险操作确认"弹窗，各自独立一份而不是
// 抽成通用组件——这里多了一个 deleting 加载态（删除是个网络请求，
// ConfirmLogoutDialog 的登出本身在别处处理，不需要在弹窗里等结果）。
export function ConfirmDeleteSessionDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: { id: string; label: string } | null
  onCancel: () => void
  onConfirm: (id: string) => Promise<boolean>
}) {
  const open = target !== null
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const [deleting, setDeleting] = useState(false)
  const lastTarget = useRef(target)
  if (target) lastTarget.current = target
  const current = lastTarget.current

  async function handleConfirm() {
    if (!current || deleting) return
    setDeleting(true)
    const ok = await onConfirm(current.id)
    setDeleting(false)
    // 失败时不关弹窗——保留在原地，让用户看到错误提示（由
    // consoleStore.deleteSession 内部通过 appendError 报出来）并可以重试。
    if (ok) onCancel()
  }

  if (!current) return null

  return (
    <DialogShell
      open={open}
      onClose={onCancel}
      variant="compact"
      role="alertdialog"
      labelledBy="delete-session-title"
      maxWidthClassName="max-w-sm"
      initialFocusRef={confirmButtonRef}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <Trash2 className="size-4" />
        </div>
        <div className="min-w-0 space-y-1 pt-0.5">
          <h2 id="delete-session-title" className="text-sm font-semibold">
            删除这个会话？
          </h2>
          <p className="truncate text-sm text-muted-foreground" title={current.label}>
            "{current.label}"
          </p>
          <p className="text-sm text-muted-foreground">删除后无法恢复，包括其中的对话记录和产物。</p>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} disabled={deleting}>
          取消
        </Button>
        <Button ref={confirmButtonRef} variant="destructive" onClick={handleConfirm} disabled={deleting}>
          {deleting ? '删除中…' : '删除'}
        </Button>
      </div>
    </DialogShell>
  )
}
