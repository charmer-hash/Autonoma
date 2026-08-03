import { useCallback, useRef, useState } from 'react'
import { UploadValidationError, type UploadAdapter, type UploadProgress, type UploadResult } from '../lib/upload'

export type FileUploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: UploadProgress }
  | { status: 'done'; result: UploadResult }
  | { status: 'error'; message: string }

// Thin React wrapper around an UploadAdapter: tracks progress/error state and
// owns the AbortController so a caller can cancel without threading one
// through itself. Takes the adapter as a parameter (not a hardcoded R2 one)
// so a component can swap in a mock adapter for tests.
export function useFileUpload(adapter: UploadAdapter) {
  const [state, setState] = useState<FileUploadState>({ status: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)

  const upload = useCallback(
    async (file: File) => {
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      setState({ status: 'uploading', progress: { loaded: 0, total: file.size, percent: 0 } })

      try {
        const result = await adapter.upload(file, {
          signal: controller.signal,
          onProgress: (progress) => setState({ status: 'uploading', progress }),
        })
        setState({ status: 'done', result })
        return result
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setState({ status: 'idle' })
          return null
        }
        const message = err instanceof UploadValidationError ? err.message : '上传失败，请重试。'
        setState({ status: 'error', message })
        return null
      }
    },
    [adapter],
  )

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const reset = useCallback(() => setState({ status: 'idle' }), [])

  return { state, upload, cancel, reset }
}
