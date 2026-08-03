import { Globe } from 'lucide-react'
import type { ToolResultProps } from '@/lib/tool-meta'
import { cleanSnippet, hostname, parseResult } from '@/lib/format'

type SearchResult = { title: string; url: string; snippet: string }

// No `variant` handling needed — this result is already a plain list, never
// height-capped like the *pre*-based results, so "compact" and "full" look
// identical. Still typed as ToolResultProps so it satisfies
// getToolResultComponent's shared return type.
export function WebSearchResult({ block }: ToolResultProps) {
  const result = parseResult<{ error?: string; results?: SearchResult[] }>(block.result)

  if (block.result === undefined) {
    return (
      <div className="space-y-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-2.5 rounded-xl bg-muted/40 px-3 py-2.5">
            <div className="mt-0.5 size-4 shrink-0 animate-pulse rounded-sm bg-muted-foreground/15" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-muted-foreground/15" />
              <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-muted-foreground/15" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (result?.error) {
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {result.error}
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {result?.results && result.results.length > 0 && (
        <p className="px-0.5 text-[11px] text-muted-foreground">找到 {result.results.length} 个结果</p>
      )}
      {result?.results?.map((r, i) => (
        <a
          key={i}
          href={r.url}
          target="_blank"
          rel="noreferrer"
          className="group flex items-start gap-2.5 rounded-xl border border-transparent bg-muted/40 px-3 py-2.5 text-xs transition-all hover:border-border hover:bg-muted hover:shadow-sm"
        >
          <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-foreground/10">
            <Globe className="absolute size-3 text-muted-foreground" />
            <img
              src={`https://www.google.com/s2/favicons?sz=64&domain=${hostname(r.url)}`}
              alt=""
              className="relative size-4"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="truncate text-[11px] text-muted-foreground">{hostname(r.url)}</div>
            <div className="truncate font-medium text-foreground group-hover:text-primary">{r.title}</div>
            <div className="line-clamp-2 text-muted-foreground">{cleanSnippet(r.snippet)}</div>
          </div>
        </a>
      ))}
    </div>
  )
}
