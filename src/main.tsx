import { createRoot } from 'react-dom/client'
import 'tldraw/tldraw.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import { App } from './App'
import { DialogHost } from './dialogs'
import { ErrorBoundary, sendCrash } from './ErrorBoundary'

// errors outside React's rendering (event handlers, timers) go to the server log too
window.addEventListener('error', (e) => sendCrash(e.error ?? e.message, 'window error'))

createRoot(document.getElementById('root')!).render(
  <>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <DialogHost />
  </>,
)
