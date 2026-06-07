import { DATA } from './mockData'
import type { Sftp, SftpItem, Tunnel, Monitor, TermLine } from './types'

// ---- Tunnel wire shape from Tauri backend ----
export interface TunnelStatusWire {
  id: string
  kind: string
  bind: string
  target: string | null
  bytesUp: number
  bytesDown: number
  status: string
}

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

// ---- SFTP ----

export async function getSftp(sessionId: string, path?: string): Promise<Sftp> {
  if (isTauri() && sessionId) {
    const items = await tauriInvoke<SftpItem[]>('sftp_list', { sessionId, path: path ?? '.' })
    return { path: path ?? '.', items }
  }
  return DATA.sftp
}

export async function sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<void> {
  return tauriInvoke('sftp_upload', { sessionId, localPath, remotePath })
}

export async function sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<void> {
  return tauriInvoke('sftp_download', { sessionId, remotePath, localPath })
}

export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return tauriInvoke('sftp_mkdir', { sessionId, path })
}

export async function sftpRename(sessionId: string, from: string, to: string): Promise<void> {
  return tauriInvoke('sftp_rename', { sessionId, from, to })
}

export async function sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<void> {
  return tauriInvoke('sftp_delete', { sessionId, path, isDir })
}

// ---- Bytes formatter ----
export function formatBytes(n: number): string {
  if (n === 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function wireTunnelToFrontend(w: TunnelStatusWire): Tunnel {
  const kind = (w.kind === 'L' || w.kind === 'R' || w.kind === 'D') ? w.kind as 'L' | 'R' | 'D' : 'L'
  return {
    id: w.id,
    type: kind,
    label: w.target ?? w.bind,
    via: '',
    local: w.bind,
    remote: w.target ?? '(dynamic)',
    status: w.status === 'up' ? 'up' : 'down',
    bytes: formatBytes((w.bytesUp ?? 0) + (w.bytesDown ?? 0)),
  }
}

export async function getTunnels(sessionId?: string): Promise<Tunnel[]> {
  if (isTauri() && sessionId) {
    const list = await tauriInvoke<TunnelStatusWire[]>('tunnel_list')
    return list.map(wireTunnelToFrontend)
  }
  return DATA.tunnels
}

export async function tunnelOpen(
  sessionId: string,
  spec: { kind: 'L' | 'R' | 'D'; bind: string; target?: string | null },
): Promise<string> {
  return tauriInvoke<string>('tunnel_open', { sessionId, spec })
}

export async function tunnelClose(tunnelId: string): Promise<void> {
  return tauriInvoke('tunnel_close', { tunnelId })
}

export async function getMonitor(_id?: string): Promise<Monitor> {
  return DATA.monitor
}

export async function monitorStart(sessionId: string, intervalMs = 2000): Promise<void> {
  return tauriInvoke('monitor_start', { sessionId, intervalMs })
}

export async function monitorStop(sessionId: string): Promise<void> {
  return tauriInvoke('monitor_stop', { sessionId })
}

export async function multiexecRun(sessionIds: string[], cmd: string): Promise<string> {
  return tauriInvoke<string>('multiexec_run', { sessionIds, cmd })
}

export async function getTermBuffer(_id: string): Promise<TermLine[]> {
  return DATA.termLines
}
