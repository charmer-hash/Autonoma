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
        // logout() 底层是裸 fetch，只在真正的网络层失败（断网/DNS 失败等）
        // 时才会 reject，不是"服务端返回非 2xx"那种——之前这里没有 catch，
        // 一旦真赶上网络抖动，下面清空 store、切回登录页这几行会整个不
        // 执行：确认弹窗关了，但界面还停在控制台，用户不知道自己到底退
        // 没退出。本地状态切换不该被这一次网络请求的成败卡住——服务端
        // session cookie 没清成功的话，最坏情况也只是下次还能免密续上，
        // 用户随时可以再点一次登出重试，不是安全问题。
        try {
          await logout()
        } catch (err) {
          console.error('logout request failed, proceeding with local cleanup anyway:', err)
        }
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
