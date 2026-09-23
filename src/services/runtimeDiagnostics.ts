export type RuntimeEvent = 'frontend-ready' | 'react-error' | 'invoke-error'

/** The bridge is installed by native Tauri before the application bundle loads. */
export function reportRuntimeEvent(event: RuntimeEvent, error?: unknown, operation?: string): void {
  try {
    const bridge = (window as unknown as {
      __CATIO_DIAGNOSTICS__?: { report: (event: RuntimeEvent, error?: unknown, operation?: string) => void }
    }).__CATIO_DIAGNOSTICS__
    bridge?.report(event, error, operation)
  } catch { /* diagnostics must never break a user action */ }
}
