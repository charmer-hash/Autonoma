import { useState } from 'react'

export type PanelTarget = { kind: 'tool'; id: string } | { kind: 'artifact'; id: string }

// 刻意只保留一个 {kind, id} 指针，而不是 block 本身的拷贝
// ——PreviewPanel 会在每次渲染时从当前的 `blocks` 数组中实时查找该 block。
// 一个运行中工具的 block 会在完成时原地发生变化（见 useConsoleSession
// 的 finishTool）；如果捕获快照，面板就会被冻结在打开那一刻 block 的样子。
export function usePreviewPanel() {
  const [target, setTarget] = useState<PanelTarget | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  // 记录当前是否允许 autoOpen() 触发——用户在运行过程中关闭面板，
  // 表示他们不想在这次运行剩余的过程中被持续打扰，而不是一个永久性的
  // 偏好设置（见 resetAutoOpen，会在新的一次运行开始时被调用）。
  const [allowAutoOpen, setAllowAutoOpen] = useState(true)

  function open(next: PanelTarget) {
    setTarget(next)
    setCollapsed(false)
    setAllowAutoOpen(true)
  }

  function autoOpen(next: PanelTarget) {
    if (!allowAutoOpen) return
    setTarget(next)
    setCollapsed(false)
  }

  function close() {
    setCollapsed(true)
    setAllowAutoOpen(false)
  }

  function resetAutoOpen() {
    setAllowAutoOpen(true)
  }

  return { target, collapsed, open, autoOpen, close, resetAutoOpen }
}

export type PreviewPanelController = ReturnType<typeof usePreviewPanel>
