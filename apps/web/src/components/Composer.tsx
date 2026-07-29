import { useRef } from 'react'
import { gsap } from 'gsap'
import { ArrowUp, Loader2, Paperclip } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { Textarea } from '@autonoma/ui/components/textarea'

export function Composer({
  task,
  setTask,
  running,
  onSend,
}: {
  task: string
  setTask: (task: string) => void
  running: boolean
  onSend: () => void
}) {
  const sendButtonRef = useRef<HTMLButtonElement>(null)

  function handleRunClick() {
    if (sendButtonRef.current && task.trim() && !running) {
      gsap.fromTo(sendButtonRef.current, { scale: 0.82 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' })
    }
    onSend()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleRunClick()
    }
  }

  return (
    <footer className="bg-background px-6 py-4">
      <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-2 shadow-sm transition-shadow duration-300 focus-within:border-primary/40 focus-within:shadow-[0_8px_30px_-14px_color-mix(in_oklch,var(--primary)_45%,transparent)]">
        <Textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="描述一个任务，例如“计划一次周末旅行”或“写一个打印前 10 个斐波那契数的 Python 脚本，然后运行它”"
          disabled={running}
          rows={1}
          className="max-h-40 resize-none border-0 bg-transparent px-2 shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:disabled:bg-transparent"
        />
        <div className="flex items-center justify-between px-1 pt-1">
          <Button variant="ghost" size="icon-sm" disabled title="文件上传即将上线">
            <Paperclip className="size-4" />
          </Button>
          <Button
            ref={sendButtonRef}
            size="icon-sm"
            onClick={handleRunClick}
            disabled={running || !task.trim()}
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
