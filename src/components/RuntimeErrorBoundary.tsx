import { Component, type ReactNode } from 'react'
import { openDiagnosticLogDirectory } from '../services/diagnostics'
import { reportRuntimeEvent } from '../services/runtimeDiagnostics'
import { isTauri } from '../services/transport'
import zh from '../i18n/zh.json'
import en from '../i18n/en.json'

// Do not depend on providers/hooks here: failures can originate in the providers.
export class RuntimeErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; logError: boolean }> {
  state = { failed: false, logError: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: Error) { reportRuntimeEvent('react-error', error) }
  componentDidMount() { reportRuntimeEvent('frontend-ready') }

  render() {
    if (!this.state.failed) return this.props.children
    let english = false
    try { english = localStorage.getItem('catio-lang') === 'en' } catch { /* storage unavailable */ }
    const text = (english ? en : zh).runtimeError
    return (
      <main role="alert" style={{ padding: 32, color: 'var(--text-primary)', background: 'var(--bg-canvas)', height: '100vh', boxSizing: 'border-box' }}>
        <h1 style={{ fontSize: 22 }}>{text.title}</h1>
        <p>{text.description}</p>
        <div style={{ display: 'flex', gap: 12 }}>
          <button type="button" onClick={() => window.location.reload()}>{text.reload}</button>
          {isTauri() && <button type="button" onClick={() => {
            void openDiagnosticLogDirectory().catch(() => this.setState({ logError: true }))
          }}>{text.logs}</button>}
        </div>
        {this.state.logError && <p>{text.logError}</p>}
      </main>
    )
  }
}
