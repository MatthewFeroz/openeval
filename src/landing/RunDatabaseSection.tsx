import { Component, lazy, Suspense, type ReactNode } from 'react'
import './run-database.css'

const RunDatabase = lazy(() => import('./RunDatabase').then(module => ({ default: module.RunDatabase })))

function Placeholder({ failed = false }: { failed?: boolean }) {
  return <section className="runs-section" id="runs" aria-labelledby="runs-heading" aria-busy={!failed}>
    <div className="runs-intro">
      <span className="kicker">RUN DATABASE</span>
      <h2 id="runs-heading">Every published run. Pick any two.</h2>
      {failed
        ? <p role="alert">The comparisons couldn’t load. <a href={location.href}>Reload to try again.</a></p>
        : <p role="status">Loading published comparisons…</p>}
    </div>
  </section>
}

class ExplorerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <Placeholder failed /> : this.props.children }
}

/** Keep public navigation and content available while the explorer downloads. */
export function RunDatabaseSection() {
  return <ExplorerBoundary><Suspense fallback={<Placeholder />}><RunDatabase /></Suspense></ExplorerBoundary>
}
