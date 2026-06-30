// Frontend bridge to the embedded local MCP server (Rust backend).
import { isTauri } from './ssh'
import { rpc, isServer } from './transport'

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

// ---- Server-mode per-user MCP token (P3a) ----
// Desktop never calls these (the desktop server self-auths via its per-run URL token); they are
// the server head's per-user SSE endpoint controls. The token + enabled state live in the backend
// `mcp_tokens` table, keyed by the logged-in user; the endpoint URL is composed client-side from
// `location.origin`.

export interface McpToken {
  token: string
  enabled: boolean
}

// Current user's token + enabled state (lazily minted server-side on first call so the settings
// page always has one to display). Returns an empty/disabled token outside server mode.
export async function mcpTokenGet(): Promise<McpToken> {
  if (!isServer()) return { token: '', enabled: false }
  return rpc<McpToken>('mcp_token_get')
}

// Rotate the token: the old SSE URL stops working immediately (the prior token 401s). Preserves
// the enabled state.
export async function mcpTokenRegenerate(): Promise<McpToken> {
  return rpc<McpToken>('mcp_token_regenerate')
}

// Enable/disable MCP access WITHOUT rotating the token. Disabled -> the endpoint URL 401s.
export async function mcpTokenSetEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  return rpc<{ enabled: boolean }>('mcp_token_set_enabled', { enabled })
}

// Subscribe to live-log entries. Returns an unsubscribe fn; no-op outside Tauri.
export async function onMcpLog(cb: (e: McpLogEntry) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<McpLogEntry>('mcp://log', (ev) => cb(ev.payload))
  return un
}
