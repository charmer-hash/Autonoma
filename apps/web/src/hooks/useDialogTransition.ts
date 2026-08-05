import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'

// 两套弹窗都在用的进出场动画参数——`compact` 是居中的小卡片（确认框/
// 设置面板），`large` 是更大的预览面板（文档/文件预览），后者位移更大、
// 动画也稍慢一点，视觉上更"有分量"。数值是从原本四份几乎逐字重复的
// 实现里原样搬过来的，没有改动观感。
const VARIANTS = {
  compact: { y: 8, scale: 0.97, enterDuration: 0.28, exitDuration: 0.18 },
  large: { y: 16, scale: 0.98, enterDuration: 0.3, exitDuration: 0.2 },
} as const

// 弹窗类组件共用的"进场/退场动画 + Esc 关闭 + 延迟卸载"逻辑——
// ConfirmLogoutDialog/ConfirmDeleteSessionDialog/AgentSettingsDialog
// 原先各自写了一份几乎一样的实现，抽到这里之后每处都只需要拿到
// backdropRef/cardRef 接到自己的 JSX 上、以及
// `if (!shouldRender) return null` 这一行。`large` 变体是给文档/文件的
// 全屏预览弹窗准备的，这两个弹窗后来改成了在右侧面板里展示（见
// components/PreviewPanel.tsx），当前没有组件在用，先留着不删。
//
// `render`（这里叫 shouldRender，避免跟组件自身可能用到的其他
// render/state 变量撞名）和 `open` 是两个不同的东西：`open` 是调用方
// 想要的目标状态，`shouldRender` 是"当前是否还需要挂载在 DOM 里"——
// 关闭时不能立刻卸载，要等退场动画播完，所以 `shouldRender` 会比
// `open` 变成 false 晚一拍。
export function useDialogTransition(open: boolean, onClose: () => void, variant: keyof typeof VARIANTS = 'compact') {
  const [shouldRender, setShouldRender] = useState(open)
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const { y, scale, enterDuration, exitDuration } = VARIANTS[variant]

  useLayoutEffect(() => {
    if (open) setShouldRender(true)
  }, [open])

  // 进场：在 shouldRender 追上已经为 true 的 `open` 之后触发。
  useLayoutEffect(() => {
    if (!shouldRender || !open) return
    gsap.set(backdropRef.current, { opacity: 0 })
    gsap.set(cardRef.current, { opacity: 0, y, scale })
    gsap.to(backdropRef.current, { opacity: 1, duration: 0.2, ease: 'power2.out' })
    gsap.to(cardRef.current, { opacity: 1, y: 0, scale: 1, duration: enterDuration, ease: 'power3.out' })
  }, [shouldRender, open, y, scale, enterDuration])

  // 退场：先播放动画，动画播完才真正卸载组件。
  useLayoutEffect(() => {
    if (open || !shouldRender) return
    const tl = gsap.timeline({ onComplete: () => setShouldRender(false) })
    tl.to(cardRef.current, { opacity: 0, y, scale, duration: exitDuration, ease: 'power1.in' }, 0)
    tl.to(backdropRef.current, { opacity: 0, duration: exitDuration, ease: 'power1.in' }, 0)
    return () => {
      tl.kill()
    }
  }, [open, shouldRender, y, scale, exitDuration])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return { shouldRender, backdropRef, cardRef }
}
