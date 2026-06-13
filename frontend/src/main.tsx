import { Component, Suspense, type ReactNode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { loadAgents } from './agents'
import { initPrefs } from './prefs'
import { applyTheme, getThemeMode, initThemeListener } from './theme'
import { startMobilePerfWatchdog } from './mobilePerfWatchdog'
import { lazyWithRetry } from './components/info-pane/utils/lazyWithRetry'
import { startBuildGuard } from './buildGuard'

const App = lazyWithRetry(() => import('./App.tsx'))
const MobileApp = lazyWithRetry(() => import('./MobileApp.tsx'))
const FokusApp = lazyWithRetry(() => import('./FokusApp.tsx'))
const MobileFokus = lazyWithRetry(() => import('./MobileFokus.tsx'))
const DeckMonitor = lazyWithRetry(() => import('./DeckMonitor.tsx'))
const RemoteControl = lazyWithRetry(() => import('./RemoteControl.tsx'))

// Theme vor jedem Paint setzen — erst aus localStorage (synchron),
// nach initPrefs nochmal, falls Server-Pref davon abweicht.
applyTheme(getThemeMode())
initThemeListener()

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(e: Error) { return { error: e.message + '\n' + e.stack } }
  render() {
    if (this.state.error) return <pre style={{ color: 'red', padding: 20, fontSize: 12, whiteSpace: 'pre-wrap' }}>{this.state.error}</pre>
    return this.props.children
  }
}

function Root() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    Promise.all([loadAgents(), initPrefs()]).then(() => {
      applyTheme(getThemeMode())
      setReady(true)
    })
  }, [])
  if (!ready) return null
  const pathname = document.location.pathname
  const shouldUseMobileShell = pathname.startsWith('/mobile')

  if (pathname.startsWith('/deck')) {
    startMobilePerfWatchdog('remote')
    return <DeckMonitor />
  }
  if (pathname.startsWith('/remote')) {
    startMobilePerfWatchdog('remote')
    return <RemoteControl />
  }
  if (shouldUseMobileShell) {
    startMobilePerfWatchdog('mobile')
    return <MobileApp />
  }
  if (pathname.startsWith('/fokus')) {
    // Mobile bekommt eine schlanke Tagesansicht, Desktop bleibt unangetastet.
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      startMobilePerfWatchdog('mobile')
      return <MobileFokus />
    }
    startMobilePerfWatchdog('desktop')
    return <FokusApp />
  }
  startMobilePerfWatchdog('desktop')
  return <App />
}

startBuildGuard()

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </ErrorBoundary>,
)
