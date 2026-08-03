import { useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { PreviewLoading } from './PreviewLoading'
import { UnsupportedPreview } from './UnsupportedPreview'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Vite-friendly worker setup — points at the exact worker build shipped by
// the pdfjs-dist version react-pdf depends on, bundled by Vite rather than
// fetched from a third party's CDN (no external runtime dependency, no
// version-skew risk between worker and main thread).
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

// Renders every page up front (no virtual scrolling) — simplest option, and
// fine for the artifact sizes this app deals with (agent-exported files
// capped at 20MB). Revisit with @tanstack/react-virtual if very-long PDFs
// become common.
export function PdfPreview({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.1)
  const [error, setError] = useState<string | null>(null)

  if (error) return <UnsupportedPreview name="PDF" message={`PDF 加载失败：${error}`} />

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="sticky top-0 z-10 flex items-center gap-1 self-end rounded-lg border bg-card/95 p-1 shadow-sm backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))} aria-label="缩小">
          <ZoomOut className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setScale((s) => Math.min(3, s + 0.2))} aria-label="放大">
          <ZoomIn className="size-4" />
        </Button>
      </div>
      <Document
        file={url}
        onLoadSuccess={(doc) => setNumPages(doc.numPages)}
        onLoadError={(err) => setError(err.message)}
        loading={<PreviewLoading />}
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page key={i} pageNumber={i + 1} scale={scale} className="mb-3 shadow-sm" />
        ))}
      </Document>
    </div>
  )
}
