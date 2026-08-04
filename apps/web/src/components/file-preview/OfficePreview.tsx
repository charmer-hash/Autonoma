import { useState } from 'react'
import { PreviewLoading } from './PreviewLoading'

// 内嵌了微软自家的在线查看器——不产生任何后端/基础设施成本，但文件字节流会被
// 微软的服务器获取并渲染，因此 `url` 必须在其（5 分钟的）预签名有效期内可被
// 公开访问，微软服务器才能取到文件。目前对 docx/xlsx/pptx 来说够用；如果以后
// 对隐私/可靠性有要求，可以考虑改用自建的 OnlyOffice Document Server。
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
