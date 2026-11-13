import { startObservability } from './observability'
void startObservability().catch(() => {})
import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthBoundary } from './AuthBoundary'
import HomeApp from './App'
import { SiteHeader } from './components/SiteHeader'
import './styles.css'
import './workbench.css'

// The app entry point does not export components.
// eslint-disable-next-line react-refresh/only-export-components
const App = import.meta.env.VITE_HEVAL_PUBLIC_DEMO === '1'
  ? lazy(() => import('./PublicApp'))
  : HomeApp

createRoot(document.getElementById('root')!).render(
  <StrictMode><AuthBoundary>{auth => <Suspense fallback={<SiteHeader auth={auth} workspace />}><App auth={auth} /></Suspense>}</AuthBoundary></StrictMode>,
)
