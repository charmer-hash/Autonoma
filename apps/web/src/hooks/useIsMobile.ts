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

// Mirrors Tailwind's `md` breakpoint so JS-driven layout decisions (sidebar
// default state, auto-close on navigation) agree with the CSS breakpoints
// used for the drawer-vs-push styling in Sidebar.tsx.
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
