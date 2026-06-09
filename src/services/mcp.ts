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

const STOPPED: McpInfo = { running: false, url: null, port: null }

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
