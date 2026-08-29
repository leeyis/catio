// Frontend bridge to the embedded local MCP server (Rust backend).
import { isTauri } from './ssh'
import { rpc, isServer, subscribe } from './transport'

const MCP_LOG_REPLAY_LIMIT = 200

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export interface McpInfo {
  running: boolean
  /**
   * MCP endpoint (`POST /mcp?token=`), including the per-run auth token.
   * Only set while running.
   */
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
  tool?: string
  args?: unknown
  output?: string
  isError?: boolean
  path?: string
  // Server-mode additions (P3b). Desktop's `mcp://log` payload never sets these, so they stay
  // undefined on the desktop head and the shared panel renders the desktop shape unchanged.
  userId?: number
  username?: string
  transfer?: { filename: string; bytesTransferred: number; totalBytes: number; percent: number }
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

/**
 * Serialize full-registry replacements in call order. React can publish several target snapshots
 * while a connection is being saved and opened; allowing those IPC calls to overlap lets an older
 * snapshot finish last and hide a newly connected host from list_hosts.
 */
export function createMcpTargetSyncQueue(
  sync: (databases: McpConnMeta[], hosts: McpHostMeta[]) => Promise<void>,
): (databases: McpConnMeta[], hosts: McpHostMeta[]) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (databases, hosts) => {
    // Capture immutable snapshots now, rather than when the queued task eventually starts.
    const databaseSnapshot = databases.map(database => ({ ...database }))
    const hostSnapshot = hosts.map(host => ({ ...host }))
    const next = tail
      .catch(() => undefined)
      .then(() => sync(databaseSnapshot, hostSnapshot))
    tail = next
    return next
  }
}

const enqueueMcpTargetSync = createMcpTargetSyncQueue((databases, hosts) =>
  tauriInvoke<void>('mcp_sync_targets', { databases, hosts }),
)

// Push the active DB + SSH connections so the server's tools resolve them by name.
export async function mcpSyncTargets(databases: McpConnMeta[], hosts: McpHostMeta[]): Promise<void> {
  if (!isTauri()) return
  return enqueueMcpTargetSync(databases, hosts)
}

// Replace the backend IP allowlist wholesale. Entries are single IPv4 (/32) or CIDR;
// the backend silently drops anything it cannot parse. Push this before mcp_start so the
// bind decision (127.0.0.1 vs 0.0.0.0) sees the latest list. Desktop-only.
export async function mcpSetWhitelist(entries: string[]): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('mcp_set_whitelist', { entries })
}

// Load the newest real file-log entries so the desktop panel includes calls that started before
// its event listener mounted. The backend enforces the same upper bound.
export async function mcpRecentLogs(limit = MCP_LOG_REPLAY_LIMIT): Promise<McpLogEntry[]> {
  if (!isTauri()) return []
  return tauriInvoke<McpLogEntry[]>('mcp_recent_logs', { limit })
}

async function mcpLiveLogSubscribe(): Promise<void> {
  return tauriInvoke('mcp_live_log_subscribe')
}

async function mcpLiveLogUnsubscribe(): Promise<void> {
  return tauriInvoke('mcp_live_log_unsubscribe')
}

/** Desktop-only: generate a fresh token and persist it. Returns (newToken, isRunning). */
export async function mcpRefreshToken(): Promise<[string, boolean]> {
  if (!isTauri()) throw new Error('mcpRefreshToken is desktop-only')
  return tauriInvoke('mcp_token_refresh')
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

function mcpLogReplayKey(entry: McpLogEntry): string {
  return JSON.stringify([
    entry.ts,
    entry.kind,
    entry.ip,
    entry.tool,
    entry.args,
    entry.output,
    entry.isError,
    entry.path,
  ])
}

/**
 * Merge a file replay with events buffered while that replay was loading. Because the backend
 * writes each file line before emitting its Tauri event, duplicated buffered events form an exact
 * overlap between the replay suffix and buffered prefix.
 */
export function mergeMcpLogReplay(recent: McpLogEntry[], pending: McpLogEntry[]): McpLogEntry[] {
  const maxOverlap = Math.min(recent.length, pending.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    let matches = true
    for (let i = 0; i < overlap; i++) {
      if (mcpLogReplayKey(recent[recent.length - overlap + i]) !== mcpLogReplayKey(pending[i])) {
        matches = false
        break
      }
    }
    if (matches) return [...recent, ...pending.slice(overlap)]
  }
  return [...recent, ...pending]
}

// Attach the listener first, then replay the newest file entries. Events arriving during replay
// are buffered and merged, closing both the listener-registration gap and the long-task gap.
export async function onMcpLog(cb: (e: McpLogEntry) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const pending: McpLogEntry[] = []
  let replaying = true
  const un = await listen<McpLogEntry>('mcp://log', (ev) => {
    if (replaying) pending.push(ev.payload)
    else cb(ev.payload)
  })
  let backendSubscribed = false
  try {
    await mcpLiveLogSubscribe()
    backendSubscribed = true
    const recent = await mcpRecentLogs().catch(() => [])
    for (const entry of mergeMcpLogReplay(recent, pending)) cb(entry)
    replaying = false
    let closed = false
    return () => {
      if (closed) return
      closed = true
      un()
      void mcpLiveLogUnsubscribe()
    }
  } catch (error) {
    replaying = false
    un()
    if (backendSubscribed) void mcpLiveLogUnsubscribe()
    throw error
  }
}

// Server-mode live-log stream over the shared WebSocket. `scope` is either the caller's own user
// id (their own MCP activity) or the string 'all' (admin-only — every user's activity). The server
// authorizes the subscription itself, so a non-admin can never read 'all' or another user's id.
// Returns an unsubscribe fn; no-op outside server mode. Desktop uses onMcpLog instead.
export async function onMcpServerLog(scope: number | 'all', cb: (e: McpLogEntry) => void): Promise<() => void> {
  if (!isServer()) return () => {}
  return subscribe('mcp-log://' + scope, p => cb(p as McpLogEntry))
}
