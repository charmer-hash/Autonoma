import { type ReactNode, type RefObject, useLayoutEffect } from 'react'
import { cn } from '@autonoma/ui/lib/utils'
import { useDialogTransition } from '@/hooks/useDialogTransition'

const BACKDROP = {
  compact: 'bg-black/40',
  large: 'bg-black/50',
} as const

const SHADOW = {
  compact: 'shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)]',
  large: 'shadow-[0_32px_80px_-24px_rgba(0,0,0,0.45)]',
} as const

// 四个弹窗（确认退出/Agent 设置/文档预览/文件预览）原先各自手写一份几乎
// 逐字重复的 backdrop + card 结构（含阴影字面量），现在收敛到这里。
// `compact` 是居中的小卡片，`large` 是更大的预览面板——宽度/圆角策略不同，
// 具体内容与最大宽度仍由调用方通过 children/maxWidthClassName 决定。
export function DialogShell({
  open,
  onClose,
  variant,
  role = 'dialog',
  labelledBy,
  label,
  maxWidthClassName,
  initialFocusRef,
  children,
}: {
  open: boolean
  onClose: () => void
  variant: keyof typeof BACKDROP
  role?: 'dialog' | 'alertdialog'
  labelledBy?: string
  label?: string
  maxWidthClassName: string
  initialFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const { shouldRender, backdropRef, cardRef } = useDialogTransition(open, onClose, variant)
  const isLarge = variant === 'large'

  // 进场动画播完（shouldRender 追上 open）之后再把焦点交给调用方指定的元素——
  // 之前只有 ConfirmLogoutDialog 需要这个行为，现在集中在这里，其它弹窗
  // 不传 initialFocusRef 即可保持原样不受影响。
  useLayoutEffect(() => {
    if (shouldRender && open) initialFocusRef?.current?.focus()
  }, [shouldRender, open, initialFocusRef])

  if (!shouldRender) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex justify-center',
        isLarge ? 'items-stretch p-3 sm:items-center sm:p-8' : 'items-center px-4',
      )}
    >
      <div ref={backdropRef} className={cn('absolute inset-0 backdrop-blur-sm', BACKDROP[variant])} onClick={onClose} />
      <div
        ref={cardRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        className={cn(
          'relative w-full rounded-2xl border bg-card',
          maxWidthClassName,
          isLarge ? 'flex max-h-full flex-col overflow-hidden' : 'max-h-[85vh] space-y-4 overflow-y-auto p-6',
          SHADOW[variant],
        )}
      >
        {children}
      </div>
    </div>
  )
}
