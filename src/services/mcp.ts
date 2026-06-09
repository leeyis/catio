// Frontend bridge to the embedded local MCP server (Rust backend).
import { isTauri } from './ssh'

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export interface McpInfo {
  running: boolean
  url: string | null
  port: number | null
}

export interface McpConnMeta {
  connId: string
  name: string
  dbType: string
}

const STOPPED: McpInfo = { running: false, url: null, port: null }

// Start the server; returns its bound URL. Desktop-only (throws in the browser demo).
export async function mcpStart(allowOpenWindow: boolean): Promise<McpInfo> {
  return tauriInvoke<McpInfo>('mcp_start', { allowOpenWindow })
}

export async function mcpStop(): Promise<McpInfo> {
  if (!isTauri()) return STOPPED
  return tauriInvoke<McpInfo>('mcp_stop')
}

export async function mcpStatus(): Promise<McpInfo> {
  if (!isTauri()) return STOPPED
  return tauriInvoke<McpInfo>('mcp_status')
}

export async function mcpSetAllowOpenWindow(allow: boolean): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('mcp_set_allow_open_window', { allow })
}

// Push the set of active DB connections so the server's tools can resolve them by name.
export async function mcpSyncConnections(conns: McpConnMeta[]): Promise<void> {
  if (!isTauri()) return
  return tauriInvoke('mcp_sync_connections', { conns })
}
