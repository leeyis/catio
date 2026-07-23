export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'
export type DiagnosticArea = 'terminal' | 'agent'
export type DiagnosticSource =
  | 'shell-lifecycle'
  | 'agent-capture'
  | 'busy-check'
  | 'split-request'

/**
 * Deliberately narrow diagnostic schema. Raw commands, terminal bytes, host
 * details and credentials have no field here, so call sites cannot
 * accidentally persist them while investigating terminal/Agent state.
 */
export interface DiagnosticEvent {
  level: DiagnosticLevel
  area: DiagnosticArea
  event: string
  channelId?: string
  source?: DiagnosticSource
  active?: boolean
  capture?: boolean
  busy?: boolean
}

let persistenceDisabled = false
let warnedAboutPersistence = false
let writeQueue: Promise<void> = Promise.resolve()

const isTauriRuntime = (): boolean => {
  if (typeof window === 'undefined') return false
  const runtime = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown }
    __TAURI__?: unknown
  }
  return typeof runtime.__TAURI_INTERNALS__?.invoke === 'function' || runtime.__TAURI__ !== undefined
}

/** Persist one structured event in the desktop app log. No-op outside Tauri. */
export async function writeDiagnosticLog(event: DiagnosticEvent): Promise<void> {
  if (!isTauriRuntime() || persistenceDisabled) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('diagnostics_log', { event })
}

/**
 * Fire-and-forget ordered logging for synchronous state transitions.
 * Failures never affect terminal execution and are reported at most once.
 */
export function diagnosticLog(event: DiagnosticEvent): void {
  if (!isTauriRuntime()) {
    if (import.meta.env.MODE !== 'test') console.debug('[catio:diagnostics]', event)
    return
  }
  if (persistenceDisabled) return
  writeQueue = writeQueue
    .then(() => writeDiagnosticLog(event))
    .catch(error => {
      persistenceDisabled = true
      if (!warnedAboutPersistence) {
        warnedAboutPersistence = true
        console.warn('[catio:diagnostics] 持久化诊断日志失败，后续日志已停用。', error)
      }
    })
}

/** Resolve the platform-standard Catio log directory for support/debug tools. */
export async function diagnosticLogDir(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('diagnostics_log_dir')
}
