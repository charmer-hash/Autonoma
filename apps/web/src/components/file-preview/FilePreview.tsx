import { Suspense, lazy, useEffect, useState } from 'react'
import { pickPreviewKind } from './dispatch'
import { ImagePreview } from './ImagePreview'
import { MediaPreview } from './MediaPreview'
import { OfficePreview } from './OfficePreview'
import { PreviewLoading } from './PreviewLoading'
import { TextPreview } from './TextPreview'
import type { FilePreviewSource } from './types'
import { UnsupportedPreview } from './UnsupportedPreview'

// Lazy: react-pdf (pdf.js) and papaparse are the two heaviest dependencies
// here — only worth downloading when a PDF/CSV is actually being previewed.
const PdfPreview = lazy(() => import('./PdfPreview').then((m) => ({ default: m.PdfPreview })))
const CsvPreview = lazy(() => import('./CsvPreview').then((m) => ({ default: m.CsvPreview })))

type State = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; message: string }

export function FilePreview({ source }: { source: FilePreviewSource }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    setState({ status: 'loading' })
    let cancelled = false
    source
      .resolveUrl()
      .then((url) => {
        if (!cancelled) setState({ status: 'ready', url })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : '加载失败。' })
      })
    return () => {
      cancelled = true
    }
  }, [source])

  if (state.status === 'loading') return <PreviewLoading />
  if (state.status === 'error') return <UnsupportedPreview name={source.name} message={state.message} />

  switch (pickPreviewKind(source.mimeType, source.name)) {
    case 'image':
      return <ImagePreview url={state.url} name={source.name} />
    case 'pdf':
      return (
        <Suspense fallback={<PreviewLoading />}>
          <PdfPreview url={state.url} />
        </Suspense>
      )
    case 'video':
      return <MediaPreview url={state.url} kind="video" />
    case 'audio':
      return <MediaPreview url={state.url} kind="audio" />
    case 'csv':
      return (
        <Suspense fallback={<PreviewLoading />}>
          <CsvPreview url={state.url} />
        </Suspense>
      )
    case 'office':
      return <OfficePreview url={state.url} />
    case 'text':
      return <TextPreview url={state.url} mimeType={source.mimeType} name={source.name} />
    default:
      return <UnsupportedPreview name={source.name} />
  }
}
