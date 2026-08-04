import { useEffect, useState } from 'react'
import { checkAuth, logout } from '@/lib/auth-api'
import { SplashScreen } from '@/components/SplashScreen'
import { LoginPage } from '@/pages/LoginPage'
import { Console } from '@/pages/Console'
import { useConsoleStore } from '@/store/consoleStore'
import { usePanelStore } from '@/store/panelStore'

type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [username, setUsername] = useState<string | undefined>(undefined)

  // 提取成一个函数，登录成功后也要重新调一次——否则 username 会一直
  // 停留在页面刚加载、登录前那次 checkAuth() 拿到的 undefined 上，
  // 账号菜单显示的是兜底文案"本地账号"而不是真实用户名。
  async function refreshAuth() {
    const res = await checkAuth()
    setUsername(res.username)
    setAuthState(res.authenticated ? 'authenticated' : 'unauthenticated')
  }

  useEffect(() => {
    refreshAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (authState === 'loading') {
    return <SplashScreen />
  }

  if (authState === 'unauthenticated') {
    return <LoginPage onSuccess={refreshAuth} />
  }

  return (
    <Console
      username={username}
      onLogout={async () => {
        await logout()
        // consoleStore/panelStore 都是模块级单例，不会随 Console 卸载/
        // 重新挂载自动重置——不清掉的话，换账号登录后 Console 会带着
        // 上一个账号残留的 sessionId/blocks 重新渲染，多半直接触发一条
        // "无权访问该会话" 的报错块。
        useConsoleStore.getState().reset()
        usePanelStore.getState().reset()
        setAuthState('unauthenticated')
      }}
    />
  )
}

export default App
