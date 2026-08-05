import { create } from 'zustand'

// document 跟 tool/artifact 不一样——它不是通过 id 去 blocks 数组里实时
// 查找的（document block 本身没有 id，内容也是创建后就不会再变的完整
// Markdown 文本），所以这里直接把 name/content 整个塞进 target，
// PreviewPanel 拿到手就是最终要展示的内容，不需要额外的查找步骤。
export type PanelTarget =
  | { kind: 'tool'; id: string }
  | { kind: 'artifact'; id: string }
  | { kind: 'document'; name: string; content: string }

interface PanelStore {
  target: PanelTarget | null
  collapsed: boolean
  // 用户在运行过程中关闭面板，表示他们不想在这次运行剩余的过程中被
  // 持续打扰，而不是一个永久性的偏好设置——见 consoleStore 的 `run`，
  // 每次新的一轮开始时都会调用 resetAutoOpen 重新获得自动打开的机会。
  allowAutoOpen: boolean
  open: (next: PanelTarget) => void
  autoOpen: (next: PanelTarget) => void
  close: () => void
  resetAutoOpen: () => void
  // 登出时把面板收起、清空当前指向——不然换账号登录后，面板可能还
  // 停留在上一个账号某个会话的工具/产物上。
  reset: () => void
}

// zustand store 本身就是一个可以在任意文件里 import 直接用的单例——
// 不再需要像原先的 usePreviewPanel hook 那样，只能在 Console.tsx 里
// 调用一次、再把返回值一路当 prop 往下传三层给 ToolCard/ArtifactCard。
// 每个组件按需 `usePanelStore(s => s.xxx)` 选取自己关心的切片即可，
// 其余组件不会因为这个 store 变化而跟着重渲染。
export const usePanelStore = create<PanelStore>((set, get) => ({
  target: null,
  collapsed: true,
  allowAutoOpen: true,

  open: (next) => set({ target: next, collapsed: false, allowAutoOpen: true }),

  autoOpen: (next) => {
    if (!get().allowAutoOpen) return
    set({ target: next, collapsed: false })
  },

  close: () => set({ collapsed: true, allowAutoOpen: false }),

  resetAutoOpen: () => set({ allowAutoOpen: true }),

  reset: () => set({ target: null, collapsed: true, allowAutoOpen: true }),
}))
