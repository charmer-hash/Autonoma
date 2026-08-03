import { useState } from 'react'
import { PreviewLoading } from './PreviewLoading'

// Microsoft's own online viewer, embedded — zero backend/infra cost, but the
// file's bytes get fetched and rendered by Microsoft's servers, and `url`
// must be publicly fetchable within its (5-minute) presign window for their
// server to reach it. Fine for docx/xlsx/pptx today; revisit with a
// self-hosted OnlyOffice Document Server if privacy/reliability ever
// becomes a requirement.
export function OfficePreview({ url }: { url: string }) {
  const [loading, setLoading] = useState(true)
  const src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`

  return (
    <div className="relative h-[70vh] w-full overflow-hidden rounded-md border">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-card">
          <PreviewLoading />
        </div>
      )}
      <iframe
        title="Office 文档预览"
        src={src}
        className="h-full w-full border-none"
        onLoad={() => setLoading(false)}
        allow="fullscreen"
      />
    </div>
  )
}
