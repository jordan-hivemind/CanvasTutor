// Catches a crash in part of the app so the screen doesn't go blank.
import { Component, type ReactNode } from 'react'

/** Send a crash to the server's log, so problems on other devices (an iPad) can be looked into. */
export function sendCrash(error: unknown, where = '') {
  const e = error instanceof Error ? error : new Error(String(error))
  fetch('/api/client-error', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: e.message, stack: (e.stack ?? '').slice(0, 4000), where: where.slice(0, 2000), ua: navigator.userAgent, url: location.pathname + location.search }),
  }).catch(() => {})
}

type Props = { children: ReactNode; fallback?: (error: Error, reset: () => void) => ReactNode }

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[crash]', error)
    sendCrash(error, info.componentStack ?? '')
  }
  reset = () => this.setState({ error: null })
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <div className="crash">
        <p>Something went wrong.</p>
        <pre>{error.message}</pre>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
