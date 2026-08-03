import { FileWarning } from 'lucide-react'

export function UnsupportedPreview({ name, message }: { name: string; message?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
      <FileWarning className="size-8" />
      <p>{message ?? `暂不支持预览「${name}」，下载后用本地软件打开即可。`}</p>
    </div>
  )
}
