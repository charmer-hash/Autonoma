import { useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ArrowUp, CircleAlert, Loader2, Paperclip, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { Textarea } from '@autonoma/ui/components/textarea'
import { createR2AutoUploadAdapter } from '@autonoma/upload/lib/auto'
import { UploadValidationError } from '@autonoma/upload/lib/upload'
import { cn } from '@autonoma/ui/lib/utils'
import type { SentAttachment } from '@/types/blocks'
import { formatBytes } from '@/lib/format'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getMultipartPartUrl,
  getUploadUrl,
} from '@/lib/uploads-api'
import { useConsoleStore } from '@/store/consoleStore'

// 更大的文件在技术上依然可以上传（分片上传本身没有真正的上限），
// 但服务端要先把整个文件拉进沙箱 agent 才能使用它——这是产品层面
// 针对“供 agent 读取/处理的文件”设定的上限，而不是存储或传输层的限制。
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

// 只构建一次——这些调用都不依赖组件的 state/props，
// 没有理由在每次渲染时都重新创建 adapter。
const uploadAdapter = createR2AutoUploadAdapter({
  single: { getUploadUrl, validation: { maxSizeBytes: MAX_UPLOAD_BYTES } },
  multipart: {
    createUpload: createMultipartUpload,
    getPartUrl: getMultipartPartUrl,
    completeUpload: completeMultipartUpload,
    abortUpload: abortMultipartUpload,
    validation: { maxSizeBytes: MAX_UPLOAD_BYTES },
  },
})

type ComposerAttachment = {
  id: string
  file: File
  progress: number
  status: 'uploading' | 'done' | 'error'
  error?: string
  key?: string
  controller: AbortController
}

// task/running/run 直接从 consoleStore 订阅——不再经手 Console 转发的
// props，Composer 现在只会因为这几个真正相关的切片变化而重渲染。
export function Composer() {
  const task = useConsoleStore((s) => s.task)
  const setTask = useConsoleStore((s) => s.setTask)
  const running = useConsoleStore((s) => s.running)
  const run = useConsoleStore((s) => s.run)
  const sendButtonRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])

  const uploading = attachments.some((a) => a.status === 'uploading')

  function updateAttachment(id: string, patch: Partial<ComposerAttachment>) {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      prev.find((a) => a.id === id)?.controller.abort()
      return prev.filter((a) => a.id !== id)
    })
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return
    for (const file of Array.from(fileList)) {
      const id = crypto.randomUUID()
      const controller = new AbortController()
      setAttachments((prev) => [...prev, { id, file, progress: 0, status: 'uploading', controller }])

      uploadAdapter
        .upload(file, { signal: controller.signal, onProgress: (p) => updateAttachment(id, { progress: p.percent }) })
        .then((result) => updateAttachment(id, { status: 'done', key: result.key, progress: 100 }))
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return // 已被用户移除，无需处理
          const message = err instanceof UploadValidationError || err instanceof Error ? err.message : '上传失败。'
          updateAttachment(id, { status: 'error', error: message })
        })
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleRunClick() {
    if (running || uploading) return
    if (!task.trim()) {
      // 没有输入任何内容就按下 Enter 或点击——没有可发送的内容，
      // 但如果什么反应都没有会显得像是坏了。一个快速的抖动动画可以
      // 传达“我收到了，但这里没有内容”，而不需要额外弹一个提示框。
      if (cardRef.current) {
        gsap.fromTo(
          cardRef.current,
          { x: -6 },
          { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.35)' },
        )
      }
      return
    }
    if (sendButtonRef.current) {
      gsap.fromTo(sendButtonRef.current, { scale: 0.82 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' })
    }
    const ready: SentAttachment[] = attachments
      .filter((a): a is ComposerAttachment & { key: string } => a.status === 'done' && Boolean(a.key))
      .map((a) => ({
        key: a.key,
        filename: a.file.name,
        mimeType: a.file.type || 'application/octet-stream',
        size: a.file.size,
        // 图片本地立刻可预览，不用等服务端把附件记录落库、也不用等
        // 网络请求——见 MessageList.tsx 的 AttachmentChip。
        previewUrl: a.file.type.startsWith('image/') ? URL.createObjectURL(a.file) : undefined,
      }))
    run(ready)
    setAttachments([])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleRunClick()
    }
  }

  return (
    <footer className="bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-4">
      <div
        ref={cardRef}
        className="mx-auto max-w-3xl rounded-2xl border bg-card p-2 shadow-sm transition-shadow duration-300 focus-within:border-primary/40 focus-within:shadow-[0_8px_30px_-14px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <Textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="描述一个任务，例如“计划一次周末旅行”或“写一个打印前 10 个斐波那契数的 Python 脚本，然后运行它”"
          disabled={running}
          rows={1}
          className="max-h-40 resize-none border-0 bg-transparent px-2 shadow-none placeholder:text-muted-foreground/50 focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:disabled:bg-transparent"
        />
        <div className="flex items-center justify-between px-1 pt-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={running}
            onClick={() => fileInputRef.current?.click()}
            aria-label="上传文件"
          >
            <Paperclip className="size-4" />
          </Button>
          <Button
            ref={sendButtonRef}
            size="icon-sm"
            onClick={handleRunClick}
            disabled={running || uploading || !task.trim()}
            aria-label="发送"
            className="bg-gradient-to-br from-primary to-chart-2 shadow-[0_6px_20px_-8px_color-mix(in_oklch,var(--primary)_55%,transparent)] transition-shadow hover:opacity-90 hover:shadow-[0_8px_24px_-6px_color-mix(in_oklch,var(--primary)_65%,transparent)]"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        </div>
      </div>
    </footer>
  )
}

function AttachmentChip({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove: () => void }) {
  const { file, status, progress, error } = attachment
  return (
    <div
      className={cn(
        'relative flex items-center gap-1.5 overflow-hidden rounded-lg border bg-background px-2.5 py-1.5 text-xs',
        status === 'error' && 'border-destructive/40',
      )}
    >
      {status === 'uploading' && (
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 bg-primary/10 transition-[width]"
          style={{ width: `${progress}%` }}
        />
      )}
      {status === 'error' ? (
        <CircleAlert className="relative z-10 size-3.5 shrink-0 text-destructive" />
      ) : (
        <Paperclip className="relative z-10 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="relative z-10 max-w-32 truncate font-medium" title={error ?? file.name}>
        {file.name}
      </span>
      <span className="relative z-10 shrink-0 text-muted-foreground">
        {status === 'uploading' ? `${progress}%` : status === 'error' ? '失败' : formatBytes(file.size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除 ${file.name}`}
        className="relative z-10 flex size-3.5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
