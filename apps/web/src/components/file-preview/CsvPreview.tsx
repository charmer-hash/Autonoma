import { useEffect, useState } from 'react'
import Papa from 'papaparse'
import { PreviewLoading } from './PreviewLoading'
import { UnsupportedPreview } from './UnsupportedPreview'

// Matches keyu-monorepo's preview cap: large CSVs would otherwise choke the
// browser rendering a giant <table>. Users needing the full data should
// download it rather than scroll a preview.
const PREVIEW_ROW_LIMIT = 100

type State =
  | { status: 'loading' }
  | { status: 'ready'; headers: string[]; rows: string[][]; truncated: boolean }
  | { status: 'error'; message: string }

export function CsvPreview({ url }: { url: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    setState({ status: 'loading' })
    let cancelled = false
    Papa.parse<string[]>(url, {
      download: true,
      worker: true,
      skipEmptyLines: true,
      preview: PREVIEW_ROW_LIMIT + 1,
      complete: (result) => {
        if (cancelled) return
        const [headers = [], ...rows] = result.data
        setState({
          status: 'ready',
          headers,
          rows: rows.slice(0, PREVIEW_ROW_LIMIT),
          truncated: rows.length > PREVIEW_ROW_LIMIT,
        })
      },
      error: (err) => {
        if (!cancelled) setState({ status: 'error', message: err.message })
      },
    })
    return () => {
      cancelled = true
    }
  }, [url])

  if (state.status === 'loading') return <PreviewLoading />
  if (state.status === 'error') return <UnsupportedPreview name="CSV" message={`CSV 解析失败：${state.message}`} />

  return (
    <div className="space-y-2">
      <div className="overflow-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/60">
            <tr>
              {state.headers.map((header, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, i) => (
              <tr key={i} className="border-t">
                {row.map((cell, j) => (
                  <td key={j} className="max-w-64 truncate whitespace-nowrap px-3 py-1.5">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.truncated && (
        <p className="text-xs text-muted-foreground">仅预览前 {PREVIEW_ROW_LIMIT} 行，下载查看完整内容。</p>
      )}
    </div>
  )
}
