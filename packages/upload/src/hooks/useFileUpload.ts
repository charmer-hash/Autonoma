import { useCallback, useRef, useState } from 'react'
import { UploadValidationError, type UploadAdapter, type UploadProgress, type UploadResult } from '../lib/upload'

export type FileUploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: UploadProgress }
  | { status: 'done'; result: UploadResult }
  | { status: 'error'; message: string }

// 对 UploadAdapter 的一层轻量 React 封装：跟踪进度/错误状态，并持有
// AbortController，让调用方无需自己维护一个即可取消上传。适配器以参数
// 形式传入（而不是写死用 R2 的），这样组件在测试时可以换用一个 mock
// 适配器。
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
