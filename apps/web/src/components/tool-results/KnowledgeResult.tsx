import { API_URL } from '@/lib/api-client'
import type { ToolResultProps } from '@/lib/tool-meta'

type Result = { status?: string; warning?: string; sources?: {
  ref: string; documentId: string; filename: string; pageNumber: number | null; headingPath: string | null; content: string
}[] }

export function KnowledgeResult({ block }: ToolResultProps) {
  let result: Result
  try { result = JSON.parse(block.result ?? '{}') as Result }
  catch { return <p className="whitespace-pre-wrap text-xs">{block.result}</p> }
  return <div className="space-y-2 text-xs">
    {result.warning && <p className="text-amber-600">{result.warning}</p>}
    {!result.sources?.length && <p className="text-muted-foreground">未找到相关片段。</p>}
    {result.sources?.map((source) => <div key={source.ref} className="rounded-md border p-2">
      <a className="font-medium text-primary hover:underline" href={`${API_URL}/api/knowledge/documents/${source.documentId}/source`} target="_blank" rel="noreferrer">
        [{source.ref}] {source.filename}{source.pageNumber ? ` · 第 ${source.pageNumber} 页` : ''}{source.headingPath ? ` · ${source.headingPath}` : ''}
      </a>
      <p className="mt-1 line-clamp-5 whitespace-pre-wrap text-muted-foreground">{source.content}</p>
    </div>)}
  </div>
}
