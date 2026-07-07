import { DATA } from './mockData'
import type { SftpItem, Tunnel, Monitor, TermLine } from './types'

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
export const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export function sshErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

export function isSshSessionLostError(error: unknown): boolean {
  const kind = error && typeof error === 'object' && 'kind' in error
    ? String((error as { kind?: unknown }).kind)
    : ''
  if (kind === 'NotFound' || kind === 'ChannelClosed') return true

  const message = sshErrorMessage(error).toLowerCase()
  if (message.includes('session not found') || message.includes('channel closed')) return true
  if (message.includes('session closed')) return true
  return /\b(connection reset|broken pipe|disconnect|disconnected|connection closed|connection aborted)\b/.test(message)
}

// Web transport: rpc() routes ssh_* request/response over HTTP in server mode; subscribe()/wsCmd()
// carry the terminal stream + term_* commands over the WebSocket (M3).
import { rpc, isServer, subscribe, wsCmd, wsNotify } from './transport'

// ---- SSH session lifecycle ----

export type AuthMethod = { method: 'password' } | { method: 'keyFile'; path: string }

export interface JumpConfig {
  host: string
  port: number
  user: string
  auth: AuthMethod
  secret?: string
}

export interface SshConnectArgs {
  host: string
  port: number
  user: string
  auth: AuthMethod
  secret?: string
  jump?: JumpConfig
}

export interface SshConnectResult {
  sessionId: string
  hostKeyFingerprint: string
  hostKeyTrusted: boolean
}

export interface SshTestResult {
  ok: boolean
  latencyMs: number
  error?: string
}

// `name` is the SSH profile display name, threaded through as a top-level sibling of `args` so the
// server head can label the host (for the per-user MCP tools' list_hosts). Additive: desktop
// ignores the extra kwarg; callers pass the display name.
export async function sshConnect(args: SshConnectArgs, name?: string): Promise<SshConnectResult> {
  return rpc<SshConnectResult>('ssh_connect', { args, name })
}

// Real connection test: connect+auth then disconnect, returning latency.
// Outside Tauri/server there is no SSH stack, so report a non-success result rather
// than pretending the test passed.
export async function sshTest(args: SshConnectArgs): Promise<SshTestResult> {
  if (!isTauri() && !isServer()) return { ok: false, latencyMs: 0, error: 'desktop-only' }
  return rpc<SshTestResult>('ssh_test', { args })
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  return rpc('ssh_disconnect', { sessionId })
}

export async function sshTrustHost(hostPort: string, fingerprint: string): Promise<void> {
  return rpc('ssh_trust_host', { hostPort, fingerprint })
}

// ---- ~/.ssh/config import ----

export interface ImportedJump {
  host: string
  port: number
  user: string
  identityFile?: string | null
}

export interface ImportedHost {
  alias: string
  host: string
  port: number
  user: string
  identityFile?: string | null
  jump?: ImportedJump | null
}

// Parse the local ~/.ssh/config (Tauri-only; returns [] in the browser demo).
export async function importSshConfig(): Promise<ImportedHost[]> {
  if (!isTauri()) return []
  return tauriInvoke<ImportedHost[]>('import_ssh_config')
}

// ---- Terminal channel ----

// Terminal commands: in server mode they ride the WebSocket (`wsCmd`) alongside the output
// stream; on desktop they are plain Tauri invokes. term_open returns the channel id either way
// (the WS reply wraps it in `{ chanId }`).
export async function termOpen(sessionId: string, cols: number, rows: number): Promise<string> {
  if (isServer()) return (await wsCmd<{ chanId: string }>('term_open', { sessionId, cols, rows })).chanId
  return tauriInvoke<string>('term_open', { sessionId, cols, rows })
}

export async function termWrite(sessionId: string, chanId: string, dataBase64: string): Promise<void> {
  if (isServer()) { await wsCmd('term_write', { sessionId, chanId, dataBase64 }); return }
  return tauriInvoke('term_write', { sessionId, chanId, dataBase64 })
}

export async function termResize(sessionId: string, chanId: string, cols: number, rows: number): Promise<void> {
  if (isServer()) { await wsCmd('term_resize', { sessionId, chanId, cols, rows }); return }
  return tauriInvoke('term_resize', { sessionId, chanId, cols, rows })
}

export async function termClose(sessionId: string, chanId: string): Promise<void> {
  if (isServer()) { await wsCmd('term_close', { sessionId, chanId }); return }
  return tauriInvoke('term_close', { sessionId, chanId })
}

// ---- Non-SSH terminals (local shell / serial / telnet) ----
// They reuse the same `term://{chanId}` event protocol but a session-independent
// registry, so write/resize/close take only chanId (no sessionId).

export async function termOpenLocal(cols: number, rows: number): Promise<string> {
  return tauriInvoke<string>('term_open_local', { cols, rows })
}

export async function termOpenSerial(port: string, baud: number): Promise<string> {
  return tauriInvoke<string>('term_open_serial', { port, baud })
}

export async function termOpenTelnet(host: string, port: number): Promise<string> {
  return tauriInvoke<string>('term_open_telnet', { host, port })
}

/** Open a Mosh terminal by delegating to the system `mosh` client in a local PTY. */
export async function termOpenMosh(host: string, user: string, cols: number, rows: number): Promise<string> {
  return tauriInvoke<string>('term_open_mosh', { host, user, cols, rows })
}

export async function serialListPorts(): Promise<string[]> {
  if (!isTauri()) return []
  return tauriInvoke<string[]>('serial_list_ports')
}

/** Signal the backend that the frontend has registered its `term://` listener, so the
 *  reader thread may start (prevents losing the first screen of output). */
export async function termLocalReady(chanId: string): Promise<void> {
  return tauriInvoke('term_local_ready', { chanId })
}

export async function termLocalWrite(chanId: string, dataBase64: string): Promise<void> {
  return tauriInvoke('term_local_write', { chanId, dataBase64 })
}

export async function termLocalResize(chanId: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke('term_local_resize', { chanId, cols, rows })
}

export async function termLocalClose(chanId: string): Promise<void> {
  return tauriInvoke('term_local_close', { chanId })
}

// ---- VNC remote desktop ----

// VNC: framebuffer stream (vnc-init/rect/closed) flows over the WS in server mode (via the
// subscribe()-backed `listen` in VncPane); connect/pointer/key/close ride the WS too as `wsCmd`.
export async function vncConnect(host: string, port: number, password: string): Promise<string> {
  // 30s timeout accommodates the backend's TCP-connect (10s) + handshake (15s) worst case.
  if (isServer()) return (await wsCmd<{ sessionId: string }>('vnc_connect', { host, port, password }, 30000)).sessionId
  return tauriInvoke<string>('vnc_connect', { host, port, password })
}
export async function vncPointer(sessionId: string, mask: number, x: number, y: number): Promise<void> {
  // Fire-and-forget: a mousemove must not pay a request/reply round-trip.
  if (isServer()) { wsNotify('vnc_pointer', { sessionId, mask, x, y }); return }
  return tauriInvoke('vnc_pointer', { sessionId, mask, x, y })
}
export async function vncKey(sessionId: string, down: boolean, keysym: number): Promise<void> {
  if (isServer()) { wsNotify('vnc_key', { sessionId, down, keysym }); return }
  return tauriInvoke('vnc_key', { sessionId, down, keysym })
}
export async function vncClose(sessionId: string): Promise<void> {
  if (isServer()) { await wsCmd('vnc_close', { sessionId }); return }
  return tauriInvoke('vnc_close', { sessionId })
}

/** Launch the platform RDP client (mstsc / xfreerdp / Microsoft Remote Desktop) for host:port. */
export async function rdpLaunch(host: string, port: number, user: string): Promise<void> {
  return tauriInvoke('rdp_launch', { host, port, user })
}

// ---- Event listener ----
// Returns an unlisten callback. No-op (returns no-op) outside Tauri.
// Uses Tauri's Event<T> generic so cb is fully typed without `any`.

// Delegates to the transport's `subscribe`: Tauri `listen` on desktop, the WebSocket
// subscription in server mode, and a no-op in dev/test. All terminal/history/monitor panes
// route their event subscriptions through here, so they stream in the browser unchanged.
export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  return subscribe(event, p => cb(p as T))
}

// ---- SFTP ----

/** List a remote directory. Returns entries with rich metadata (size/mtime/perms/owner/group). */
export async function sftpList(sessionId: string, path: string): Promise<SftpItem[]> {
  if ((isTauri() || isServer()) && sessionId) {
    return rpc<SftpItem[]>('sftp_list', { sessionId, path })
  }
  return []
}

/** Resolve a path to its absolute form ("." → home dir). */
export async function sftpRealpath(sessionId: string, path: string): Promise<string> {
  if ((isTauri() || isServer()) && sessionId) {
    return rpc<string>('sftp_realpath', { sessionId, path })
  }
  return path
}

/** Start an upload from a local filesystem path (desktop only). Returns a transfer id; progress
 *  flows via `transfer-progress-{id}` events. Over web use {@link sftpUploadWeb} (HTML5). */
export async function sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<string> {
  return tauriInvoke<string>('sftp_upload', { sessionId, localPath, remotePath })
}

/** Start a download to a local filesystem path (desktop only). Over web use
 *  {@link sftpDownloadUrl} (the browser saves the file). */
export async function sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<string> {
  return tauriInvoke<string>('sftp_download', { sessionId, remotePath, localPath })
}

/** Server-mode download: the URL the browser navigates to so it saves the remote file itself
 *  (the cookie rides along same-origin). */
export function sftpDownloadUrl(sessionId: string, remotePath: string): string {
  const qs = new URLSearchParams({ sessionId, path: remotePath })
  return `/api/sftp/download?${qs.toString()}`
}

/** Server-mode upload: POST a browser-picked File; the server writes it to `remotePath` over SFTP.
 *  Uses XMLHttpRequest (not fetch) so `upload.onprogress` can drive a progress bar + speed readout
 *  — fetch has no upload-progress. `onProgress(loaded,total)` fires as bytes go out; an `AbortSignal`
 *  cancels the in-flight POST. */
export function sftpUploadWeb(
  sessionId: string,
  remotePath: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fd = new FormData()
    fd.append('sessionId', sessionId)
    fd.append('remotePath', remotePath)
    fd.append('file', file)
    const xhr = new XMLHttpRequest()
    let abortHandler: (() => void) | undefined
    const cleanup = () => { if (signal && abortHandler) signal.removeEventListener('abort', abortHandler) }
    // Reject before send() if the signal is already aborted: xhr.abort() on an un-sent request is
    // not guaranteed to fire `onabort`, which would leave the promise hanging.
    if (signal?.aborted) { reject(new DOMException('上传已取消', 'AbortError')); return }
    xhr.open('POST', '/api/sftp/upload')
    xhr.withCredentials = true
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total) }
    xhr.onload = () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return }
      let msg = `HTTP ${xhr.status}`
      try { const j = JSON.parse(xhr.responseText) as { error?: unknown }; if (j?.error) msg = String(j.error) } catch { /* non-json */ }
      reject(new Error(msg))
    }
    xhr.onerror = () => { cleanup(); reject(new Error('上传失败(网络错误)')) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('上传已取消', 'AbortError')) }
    if (signal) {
      abortHandler = () => xhr.abort()
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    xhr.send(fd)
  })
}

export async function sftpTouch(sessionId: string, path: string): Promise<void> {
  return rpc('sftp_touch', { sessionId, path })
}

/** Request cancellation of an in-flight upload/download by its transfer id (desktop transfers). */
export async function sftpTransferCancel(transferId: string): Promise<void> {
  return tauriInvoke('sftp_transfer_cancel', { transferId })
}

export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return rpc('sftp_mkdir', { sessionId, path })
}

export async function sftpRename(sessionId: string, from: string, to: string): Promise<void> {
  return rpc('sftp_rename', { sessionId, from, to })
}

export async function sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<void> {
  return rpc('sftp_delete', { sessionId, path, isDir })
}

// ---- Remote file editing ----

/** Remote file content for inline editing. Mirrors backend `RemoteFileContent`. */
export interface RemoteFileContent {
  /** UTF-8 text (lossy); empty when binary. */
  content: string
  /** True when the file looks binary (NUL in first 8KiB). */
  isBinary: boolean
  /** Total byte size on the server. */
  size: number
  /** mtime (unix seconds), used as the conflict-detection base. */
  modified: number | null
  /** Permission bits (low 12, octal), restored on save. */
  mode: number | null
  /** True when content was truncated to the size limit (read-only preview). */
  truncated: boolean
}

/** Read a remote file's content into memory for editing. `maxBytes` defaults to 5MB on the backend. */
export async function sftpReadFile(sessionId: string, path: string, maxBytes?: number): Promise<RemoteFileContent> {
  return rpc<RemoteFileContent>('sftp_read_file', { sessionId, path, maxBytes })
}

/**
 * Write content back to a remote file. Pass `baseModified` (the mtime from the prior read) to
 * enable conflict detection — the backend returns an `SshError` of kind `Conflict` if the file
 * changed on the server. Returns the new mtime to use as the next save's base.
 */
export async function sftpWriteFile(
  sessionId: string,
  path: string,
  content: string,
  baseModified?: number | null,
  mode?: number | null,
): Promise<number> {
  return rpc<number>('sftp_write_file', { sessionId, path, content, baseModified, mode })
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
  if ((isTauri() || isServer()) && sessionId) {
    const list = await rpc<TunnelStatusWire[]>('tunnel_list')
    return list.map(wireTunnelToFrontend)
  }
  return []
}

export async function tunnelOpen(
  sessionId: string,
  spec: { kind: 'L' | 'R' | 'D'; bind: string; target?: string | null },
): Promise<string> {
  return rpc<string>('tunnel_open', { sessionId, spec })
}

export async function tunnelClose(tunnelId: string): Promise<void> {
  return rpc('tunnel_close', { tunnelId })
}

const EMPTY_MONITOR: Monitor = {
  host: '',
  cpu: [],
  mem: [],
  net: [],
  disk: 0,
  diskTotal: '',
  diskUsed: '',
  cores: 0,
  memTotal: '',
  memUsed: '',
  gpus: [],
  procs: [],
}

export async function getMonitor(sessionId?: string): Promise<Monitor> {
  if (isTauri() && sessionId) {
    // Live data arrives via monitor:// events; return empty to seed state
    return EMPTY_MONITOR
  }
  return EMPTY_MONITOR
}

export async function monitorStart(sessionId: string, intervalMs = 2000): Promise<void> {
  // Server mode: drive over the WS so monitor://{sessionId} frames stream through the hub.
  if (isServer()) { await wsCmd('monitor_start', { sessionId, intervalMs }); return }
  return tauriInvoke('monitor_start', { sessionId, intervalMs })
}

export async function monitorStop(sessionId: string): Promise<void> {
  if (isServer()) { await wsCmd('monitor_stop', { sessionId }); return }
  return tauriInvoke('monitor_stop', { sessionId })
}

export async function multiexecRun(sessionIds: string[], cmd: string): Promise<string> {
  return tauriInvoke<string>('multiexec_run', { sessionIds, cmd })
}

/** Gather a compact host summary (OS/time/CPU/mem/disk/GPU) via SSH.
 *  Returns an empty string outside Tauri (no SSH stack available). */
export async function sshSysinfo(sessionId: string): Promise<string> {
  if (!isTauri() && !isServer()) return ''
  return rpc<string>('ssh_sysinfo', { sessionId })
}

/** Detect the remote OS id (ubuntu/debian/alpine/centos/fedora/arch/rhel/macos/linux)
 *  so the sidebar glyph can show the real OS logo. Empty string outside Tauri/server. */
export async function sshDetectOs(sessionId: string): Promise<string> {
  if (!isTauri() && !isServer()) return ''
  return rpc<string>('ssh_detect_os', { sessionId })
}

export async function getTermBuffer(_id: string): Promise<TermLine[]> {
  return DATA.termLines
}

// ---- History audit event subscription ----

export interface HistoryEvent {
  id: string
  command: string
  exitCode: number | null
  cwd: string
  durationMs: number
  host: string
}

export async function onHistory(sessionId: string, cb: (e: HistoryEvent) => void): Promise<() => void> {
  return listen<HistoryEvent>(`history://${sessionId}`, cb)
}
