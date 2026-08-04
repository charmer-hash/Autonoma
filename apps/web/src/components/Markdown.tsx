import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 流式输出期间，历史消息里的 Markdown 内容不会变——记忆化避免每个
// token delta 都重新解析并重新渲染整份已经渲染完的 AST（见 BlockView）。
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
})
