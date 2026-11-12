import { useEffect, useState } from 'react'
import { api } from './api'
import { Login } from './Login'
import { Shell } from './Shell'

export function App() {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking')
  useEffect(() => {
    api
      .me()
      .then(() => setState('in'))
      .catch(() => setState('out'))
  }, [])
  if (state === 'checking') return null
  if (state === 'out') return <Login onDone={() => setState('in')} />
  return <Shell onLoggedOut={() => setState('out')} />
}
