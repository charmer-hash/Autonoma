import { useSyncExternalStore } from 'react'

const QUERY = '(max-width: 767px)'

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches
}

// 与 Tailwind 的 `md` 断点保持一致，使由 JS 驱动的布局决策（侧边栏的
// 默认状态、导航时自动关闭）与 Sidebar.tsx 中用于抽屉/推挤样式的
// CSS 断点相吻合。
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
