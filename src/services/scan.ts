import type { DbType } from './db'

// ---- Tauri guard（与 src/services/ssh.ts 对齐：守卫 + 动态 import）----
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// 返回 unlisten 回调；非 Tauri 下返回 no-op。
async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => { /* no-op outside Tauri */ }
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, e => cb(e.payload))
}

// ---- 类型契约 ----

export type ScanMode = 'host' | 'db'
export type ScanStatus = 'authed' | 'unauthed' | 'open'

export interface ScanCred {
  user: string
  password: string
}

export interface ScanKeySpec {
  path: string
  name: string
}

export interface ScanEngineProbe {
  engineId: string
  dbType: DbType
  driverProfile?: string
  port: number
}

export interface ScanArgs {
  mode: ScanMode
  ranges: string[]
  ports?: number[]
  engines?: ScanEngineProbe[]
  creds: ScanCred[]
  keys?: ScanKeySpec[]
  keyUsers?: string[]
  concurrency?: number
}

export interface ScanFound {
  scanId: string
  ip: string
  port: number
  address: string
  kind: ScanMode
  engineId?: string
  dbType?: string
  driverProfile?: string
  os?: string
  version?: string
  status: ScanStatus
  hitUser?: string
  hitSecret?: string
  hitAuthKind?: 'password' | 'key'
  hitKeyName?: string
  hitKeyPath?: string
}

export interface ScanProgress {
  scanId: string
  scanned: number
  total: number
  found: number
  failed: number
}

// ---- 命令 ----

/** 启动扫描，返回 scanId。非 Tauri 环境抛错。 */
export async function scanStart(args: ScanArgs): Promise<string> {
  if (!isTauri()) throw new Error('scanStart 仅在 Tauri 环境可用')
  return tauriInvoke<string>('scan_start', { args })
}

/** 取消指定扫描。 */
export async function scanCancel(scanId: string): Promise<void> {
  return tauriInvoke<void>('scan_cancel', { scanId })
}

// ---- 事件监听（返回 unlisten；非 Tauri 下 no-op）----

export async function onScanProgress(cb: (p: ScanProgress) => void): Promise<() => void> {
  return tauriListen<ScanProgress>('scan://progress', cb)
}

export async function onScanFound(cb: (f: ScanFound) => void): Promise<() => void> {
  return tauriListen<ScanFound>('scan://found', cb)
}

export async function onScanDone(cb: (d: { scanId: string }) => void): Promise<() => void> {
  return tauriListen<{ scanId: string }>('scan://done', cb)
}
