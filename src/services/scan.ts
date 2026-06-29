import type { DbType } from './db'
import { rpc, isServer, subscribe, wsCmd } from './transport'

// ---- Tauri guard（与 src/services/ssh.ts 对齐：守卫 + 动态 import）----
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// Event subscription routed through the transport: Tauri `listen` on desktop, the WebSocket
// subscription in server mode (the scan runs on the server and streams scan:// topics), no-op in dev.
async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  return subscribe(event, p => cb(p as T))
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
  /** 展示用系统名（如 "Ubuntu 22.04.3 LTS"）。 */
  os?: string
  /** OS 目录 id（ubuntu/centos…），用于入库后侧栏品牌 logo。 */
  osId?: string
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

export type ScanLogLevel = 'info' | 'attempt' | 'hit' | 'miss' | 'warn'

export interface ScanLog {
  scanId: string
  level: ScanLogLevel
  message: string
}

// ---- 命令 ----

/** 启动扫描，返回 scanId。Server 模式经 WS(扫描跑在服务器、scan:// 帧经 hub 推送);
 *  桌面经 Tauri invoke;dev/test 抛错。 */
export async function scanStart(args: ScanArgs): Promise<string> {
  if (isServer()) return wsCmd<string>('scan_start', { args })
  if (!isTauri()) throw new Error('scanStart 仅在 Tauri 环境可用')
  return rpc<string>('scan_start', { args })
}

/** 取消指定扫描。 */
export async function scanCancel(scanId: string): Promise<void> {
  if (isServer()) { await wsCmd('scan_cancel', { scanId }); return }
  if (!isTauri()) return
  await rpc('scan_cancel', { scanId })
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

export async function onScanLog(cb: (l: ScanLog) => void): Promise<() => void> {
  return tauriListen<ScanLog>('scan://log', cb)
}
