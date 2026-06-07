import { DATA } from './mockData'
import type { Sftp, Tunnel, Monitor, TermLine } from './types'

// ---- Tauri guard — function so tests can set window.__TAURI_INTERNALS__ dynamically ----
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ---- SSH session lifecycle ----

export type AuthMethod = { method: 'password' } | { method: 'keyFile'; path: string }

export interface SshConnectArgs {
  host: string
  port: number
  user: string
  auth: AuthMethod
  secret?: string
}

export interface SshConnectResult {
  sessionId: string
  hostKeyFingerprint: string
  hostKeyTrusted: boolean
}

export async function sshConnect(args: SshConnectArgs): Promise<SshConnectResult> {
  return tauriInvoke<SshConnectResult>('ssh_connect', { args })
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  return tauriInvoke('ssh_disconnect', { sessionId })
}

export async function sshTrustHost(hostPort: string, fingerprint: string): Promise<void> {
  return tauriInvoke('ssh_trust_host', { hostPort, fingerprint })
}

// ---- Terminal channel ----

export async function termOpen(sessionId: string, cols: number, rows: number): Promise<string> {
  return tauriInvoke<string>('term_open', { sessionId, cols, rows })
}

export async function termWrite(sessionId: string, chanId: string, dataBase64: string): Promise<void> {
  return tauriInvoke('term_write', { sessionId, chanId, dataBase64 })
}

export async function termResize(sessionId: string, chanId: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke('term_resize', { sessionId, chanId, cols, rows })
}

export async function termClose(sessionId: string, chanId: string): Promise<void> {
  return tauriInvoke('term_close', { sessionId, chanId })
}

// ---- Event listener ----
// Returns an unlisten callback. No-op (returns no-op) outside Tauri.
// Uses Tauri's Event<T> generic so cb is fully typed without `any`.

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => { /* no-op outside Tauri */ }
  const { listen: tauriListen } = await import('@tauri-apps/api/event')
  return tauriListen<T>(event, e => cb(e.payload))
}

// ---- Mock fallbacks (panels use these until B/C/D rewire them) ----

export async function getSftp(_id: string): Promise<Sftp> {
  return DATA.sftp
}

export async function getTunnels(_id: string): Promise<Tunnel[]> {
  return DATA.tunnels
}

export async function getMonitor(_id: string): Promise<Monitor> {
  return DATA.monitor
}

export async function getTermBuffer(_id: string): Promise<TermLine[]> {
  return DATA.termLines
}
