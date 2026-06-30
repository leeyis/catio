// Frontend bridge to the embedded local MCP server (Rust backend).
import { isTauri } from './ssh'

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export interface McpInfo {
  running: boolean
  /** Full SSE endpoint including the per-run auth token (only when running). */
  url: string | null
  port: number | null
  /** True only when the running server is bound to 0.0.0.0 (whitelist has a non-loopback entry). */
  exposed: boolean
}

/** A single live-log entry pushed from the backend over the `mcp://log` Tauri event. */
export interface McpLogEntry {
  ts: string
  kind: string
  ip: string
  sessionId?: string
  tool?: string
  args?: unknown
  output?: string
  isError?: boolean
  path?: string
}

export interface McpConnMeta {
  connId: string
  name: string
  dbType: string
}

export interface McpHostMeta {
  sessionId: string
  name: string
  host: string
}

const STOPPED: McpInfo = { running: false, url: null, port: null, exposed: false }

// Start the server; returns its bound URL (with auth token). Desktop-only.
export async function mcpStart(): Promise<McpInfo> {
  return tauriInvoke<McpInfo>('mcp_start')
}

export async function mcpStop(): Promise<McpInfo> {
  if (!isTauri()) return STOPPED
  return tauriInvoke<McpInfo>('mcp_stop')
}

export async function mcpStatus(): Promise<McpInfo> {
  if (!isTauri()) return STOPPED
  return tauriInvoke<McpInfo>('mcp_status')
}

// Push the active DB + SSH connections so the server's tools resolve them by name.
export async function mcpSyncTargets(databases: McpConnMeta[], hosts: McpHostMeta[]): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('mcp_sync_targets', { databases, hosts })
}

// Replace the backend IP allowlist wholesale. Entries are single IPv4 (/32) or CIDR;
// the backend silently drops anything it cannot parse. Push this before mcp_start so the
// bind decision (127.0.0.1 vs 0.0.0.0) sees the latest list. Desktop-only.
export async function mcpSetWhitelist(entries: string[]): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('mcp_set_whitelist', { entries })
}

// Toggle live-log emission. File logging is unconditional; this only gates the
// `mcp://log` Tauri events used for the on-screen stream. Desktop-only.
export async function mcpSetLiveLog(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('mcp_set_live_log', { enabled })
}

// Subscribe to live-log entries. Returns an unsubscribe fn; no-op outside Tauri.
export async function onMcpLog(cb: (e: McpLogEntry) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<McpLogEntry>('mcp://log', (ev) => cb(ev.payload))
  return un
}
