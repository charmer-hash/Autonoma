import { useEffect, useState } from 'react'
import { prettyJson } from '@/lib/format'
import { Markdown } from '../Markdown'
import { PreviewLoading } from './PreviewLoading'
import { UnsupportedPreview } from './UnsupportedPreview'

type State = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error'; message: string }

export function TextPreview({ url, mimeType, name }: { url: string; mimeType: string; name: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    setState({ status: 'loading' })
    let cancelled = false
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`加载失败：${res.status}`)
        return res.text()
      })
      .then((text) => {
        if (!cancelled) setState({ status: 'ready', text })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : '加载失败。' })
      })
    return () => {
      cancelled = true
    }
  }, [url])

  if (state.status === 'loading') return <PreviewLoading />
  if (state.status === 'error') return <UnsupportedPreview name={name} message={state.message} />

  if (mimeType === 'text/markdown') return <Markdown text={state.text} />

  const content = mimeType === 'application/json' ? prettyJson(state.text) : state.text
  return <pre className="overflow-auto rounded-md bg-muted p-4 font-mono text-xs whitespace-pre-wrap">{content}</pre>
}
