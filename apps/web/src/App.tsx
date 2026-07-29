import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { checkAuth, logout } from '@/lib/auth-api'
import { LoginPage } from '@/pages/LoginPage'
import { Console } from '@/pages/Console'

type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')

  useEffect(() => {
    checkAuth().then((ok) => setAuthState(ok ? 'authenticated' : 'unauthenticated'))
  }, [])

  if (authState === 'loading') {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
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
