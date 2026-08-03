import { get } from 'lodash-es'
import { cn } from '@autonoma/ui/lib/utils'
import type { ToolResultProps } from '@/lib/tool-meta'
import { parseResult } from '@/lib/format'

export function RunCommandResult({ block, variant = 'compact' }: ToolResultProps) {
  const result = parseResult<{ exitCode: number; stdout: string; stderr: string }>(block.result)
  const full = variant === 'full'
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
        $ {String(get(block.args, 'command', ''))}
      </pre>
      {result && (
        <>
          <span
            className={cn(
              'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
              result.exitCode === 0
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-destructive/15 text-destructive',
            )}
          >
退出码 {result.exitCode}
          </span>
          {result.stdout && (
            <div className="relative">
              <pre
                className={cn(
                  'overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap',
                  !full && 'max-h-64',
                )}
              >
                {result.stdout}
              </pre>
              {!full && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-muted to-transparent" />
              )}
            </div>
          )}
          {result.stderr && (
            <div className="relative">
              <pre
                className={cn(
                  'overflow-auto rounded-md bg-destructive/10 p-2 font-mono text-xs whitespace-pre-wrap text-destructive',
                  !full && 'max-h-64',
                )}
              >
                {result.stderr}
              </pre>
              {!full && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-destructive/10 to-transparent" />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
