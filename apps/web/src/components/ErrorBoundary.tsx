import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@autonoma/ui/components/button'
import { BrandMark } from './BrandMark'

type Props = { children: ReactNode }
type State = { error: Error | null }

// 顶层兜底——渲染期间任何未捕获的异常（服务端返回了一个组件没预料到的
// 数据形状、某个很少走到的渲染分支里的空指针……）在没有这层的情况下会
// 让 React 把整棵树连根拔起，用户看到的就是一片空白，没有任何报错提示，
// 也没有任何恢复手段，只能靠猜要不要刷新页面。这里给一个明确的兜底
// UI + 刷新按钮。只能捕获渲染期间的异常——事件处理器/异步回调里抛出的
// 异常不会被这里捕获，那些各自已经有自己的 try/catch（参见
// consoleStore.ts 里几乎每个 action 的错误处理）。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-svh flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <BrandMark className="h-12 w-auto opacity-60" />
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">出了点问题</h1>
          <p className="max-w-sm text-sm text-muted-foreground">页面遇到了一个没有处理好的错误，刷新页面通常可以恢复。</p>
        </div>
        <Button onClick={() => window.location.reload()}>刷新页面</Button>
      </div>
    )
  }
}
