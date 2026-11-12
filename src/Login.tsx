import { useState } from 'react'
import { api } from './api'

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr('')
          try {
            await api.login(pw)
            onDone()
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'Login failed')
          } finally {
            setBusy(false)
          }
        }}
      >
        <h1>Canvas Tutor</h1>
        <input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button disabled={busy || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {err && <div className="login-err">{err}</div>}
        <p className="login-note">You'll stay signed in on this device.</p>
      </form>
    </div>
  )
}
