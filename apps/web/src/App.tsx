import { useEffect, useState } from 'react'
import { checkAuth, logout } from '@/lib/auth-api'
import { SplashScreen } from '@/components/SplashScreen'
import { LoginPage } from '@/pages/LoginPage'
import { Console } from '@/pages/Console'

type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')

  useEffect(() => {
    checkAuth().then((ok) => setAuthState(ok ? 'authenticated' : 'unauthenticated'))
  }, [])

  if (authState === 'loading') {
    return <SplashScreen />
  }

  if (authState === 'unauthenticated') {
    return <LoginPage onSuccess={() => setAuthState('authenticated')} />
  }

  return (
    <Console
      onLogout={async () => {
        await logout()
        setAuthState('unauthenticated')
      }}
    />
  )
}

export default App
