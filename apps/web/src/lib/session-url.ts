// 没有现成的基于 query string 的状态库，所以会话持久化中 URL 那一半
// （不同于 localStorage 那一半，后者在 store/consoleStore.ts 里直接读写
// localStorage 实现）在这里仍然是手写的。
export function readSessionIdFromUrl(): string | undefined {
  return new URLSearchParams(window.location.search).get('session') ?? undefined
}

export function syncSessionIdToUrl(id: string | undefined) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('session', id)
  else url.searchParams.delete('session')
  window.history.replaceState(null, '', url)
}
