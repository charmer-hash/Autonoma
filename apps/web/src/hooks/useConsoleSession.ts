import { useEffect, useState } from 'react'
import { useLocalStorageState } from 'ahooks'
import { last as lastOf } from 'lodash-es'
import type { SessionSummary } from '@autonoma/shared'
import type { Block } from '@/types/blocks'
import { runAgent } from '@/lib/agent-api'
import { getSessionMessages, listSessions } from '@/lib/sessions-api'
import { messagesToBlocks } from '@/lib/blocks'
import { readSessionIdFromUrl, syncSessionIdToUrl } from '@/lib/session-url'

export function useConsoleSession() {
  const [task, setTask] = useState('')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [running, setRunning] = useState(false)
  // sessionId is issued by the server, never picked by the client (see
  // apps/server/src/index.ts). Kept in both the URL's ?session= param (so a
  // conversation can be bookmarked/shared and reopened directly) and
  // localStorage — via ahooks' useLocalStorageState — (so a plain reload
  // without that param still continues the last conversation). The URL wins
  // when both are present.
  const [storedSessionId, setStoredSessionId] = useLocalStorageState<string | undefined>('sessionId')
  const initialSessionId = readSessionIdFromUrl() ?? storedSessionId
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  // Starts true whenever there's a sessionId to restore, so the console
  // shows a loading state instead of briefly flashing the "no messages yet"
  // empty state for a session that actually has history.
  const [messagesLoading, setMessagesLoading] = useState(Boolean(initialSessionId))

  function setActiveSessionId(id: string | undefined) {
    setStoredSessionId(id)
    syncSessionIdToUrl(id)
    setSessionId(id)
  }

  async function refreshSessions() {
    try {
      setSessions(await listSessions())
    } catch (err) {
      console.error('failed to load sessions:', err)
    } finally {
      setSessionsLoading(false)
    }
  }

  // Restores the conversation on page refresh — sessionId survives in
  // localStorage/URL but `blocks` doesn't, so without this a reload shows an
  // empty console even though the server still has the history.
  useEffect(() => {
    refreshSessions()
    // If sessionId only came from the localStorage fallback (no ?session= in
    // the URL yet), reflect it in the URL too so it's immediately shareable.
    if (sessionId && readSessionIdFromUrl() !== sessionId) {
      syncSessionIdToUrl(sessionId)
    }
    if (sessionId) {
      getSessionMessages(sessionId)
        .then((messages) => setBlocks(messagesToBlocks(messages)))
        .catch((err) => appendError(err instanceof Error ? err.message : String(err)))
        .finally(() => setMessagesLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function appendText(delta: string) {
    setBlocks((prev) => {
      const last = lastOf(prev)
      if (last?.kind === 'text') {
        return [...prev.slice(0, -1), { kind: 'text', text: last.text + delta }]
      }
      return [...prev, { kind: 'text', text: delta }]
    })
  }

  function startTool(name: string, args: unknown) {
    setBlocks((prev) => [...prev, { kind: 'tool', name, args, status: 'running' }])
  }

  function finishTool(result: string) {
    setBlocks((prev) => {
      const last = lastOf(prev)
      if (last?.kind !== 'tool') return prev
      return [...prev.slice(0, -1), { ...last, result, status: 'done' }]
    })
  }

  function appendError(text: string) {
    setBlocks((prev) => [...prev, { kind: 'error', text }])
  }

  function appendDocument(name: string, content: string) {
    setBlocks((prev) => [...prev, { kind: 'document', name, content }])
  }

  function adoptSessionId(id: string) {
    setActiveSessionId(id)
  }

  function handleNewSession() {
    if (running) return
    setActiveSessionId(undefined)
    setBlocks([])
    setMessagesLoading(false)
  }

  async function loadSession(id: string) {
    if (running || id === sessionId) return
    setActiveSessionId(id)
    setBlocks([])
    setMessagesLoading(true)
    try {
      const messages = await getSessionMessages(id)
      setBlocks(messagesToBlocks(messages))
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err))
    } finally {
      setMessagesLoading(false)
    }
  }

  async function run() {
    const currentTask = task.trim()
    if (!currentTask || running) return

    setTask('')
    setBlocks((prev) => [...prev, { kind: 'user', text: currentTask }])
    setRunning(true)
    try {
      for await (const event of runAgent(currentTask, sessionId)) {
        switch (event.type) {
          case 'session':
            adoptSessionId(event.sessionId)
            break
          case 'text_delta':
            appendText(event.delta)
            break
          case 'tool_call':
            startTool(event.name, event.args)
            break
          case 'tool_result':
            finishTool(event.result)
            break
          case 'document':
            appendDocument(event.name, event.content)
            break
          case 'error':
            appendError(event.message)
            break
          case 'done':
            break
        }
      }
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      refreshSessions()
    }
  }

  return {
    task,
    setTask,
    blocks,
    running,
    sessionId,
    sessions,
    sessionsLoading,
    messagesLoading,
    handleNewSession,
    loadSession,
    run,
  }
}
