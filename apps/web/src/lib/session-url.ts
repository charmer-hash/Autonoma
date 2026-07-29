// ahooks has no query-string-backed state hook, so the URL half of session
// persistence (unlike the localStorage half, via useLocalStorageState in
// useConsoleSession) stays hand-rolled here.
export function readSessionIdFromUrl(): string | undefined {
  return new URLSearchParams(window.location.search).get('session') ?? undefined
}

export function syncSessionIdToUrl(id: string | undefined) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('session', id)
  else url.searchParams.delete('session')
  window.history.replaceState(null, '', url)
}
