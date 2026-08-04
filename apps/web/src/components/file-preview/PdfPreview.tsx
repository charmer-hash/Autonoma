import { useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { PreviewLoading } from './PreviewLoading'
import { UnsupportedPreview } from './UnsupportedPreview'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// 对 Vite 友好的 worker 配置——精确指向 react-pdf 所依赖的 pdfjs-dist 版本
// 自带的 worker 构建产物，由 Vite 打包，而不是从第三方 CDN 获取（没有外部
// 运行时依赖，也不存在 worker 与主线程之间版本不一致的风险）。
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

// 一次性把所有页面都渲染出来（没有做虚拟滚动）——这是最简单的方案，对于本应用
// 处理的产物文件大小（agent 导出的文件上限为 20MB）来说也够用。如果超长 PDF
// 变得常见，可以考虑改用 @tanstack/react-virtual。
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
