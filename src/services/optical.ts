import { rpc, isTauri, isServer } from './transport'
import type { SftpItem } from './types'

export const OPTICAL_MAX_BYTES = 5 * 1024 * 1024
export interface OpticalStatus { visible: boolean; configured: boolean; canConfigure: boolean }
export interface OpticalFile { name: string; data: string }
export const opticalAvailable = () => isTauri() || isServer()
export const opticalStatus = () => rpc<OpticalStatus>('optical_status')
export const opticalUnlock = (passphrase: string, setup: boolean) => rpc<string>('optical_unlock', { passphrase, setup })
export const opticalLock = (token: string) => rpc<void>('optical_lock', { token })
export const opticalCheck = (token: string) => rpc<boolean>('optical_check', { token })
export const opticalRead = (token: string, requestId: string, sessionId: string, path: string) =>
  rpc<OpticalFile>('optical_read', { token, requestId, sessionId, path })
export const opticalCancel = (token: string, requestId: string) => rpc<void>('optical_cancel', { token, requestId })

export function canOpticalTransfer(item: SftpItem): boolean {
  return item.type === 'file' && Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= OPTICAL_MAX_BYTES
}
export function opticalErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^optical\.[A-Za-z]+$/.test(message) ? message : 'optical.operationFailed'
}

export function opticalBytes(data: string): Uint8Array {
  if (data.length > Math.ceil(OPTICAL_MAX_BYTES / 3) * 4) throw new Error('optical.tooLarge')
  const binary = atob(data)
  if (binary.length > OPTICAL_MAX_BYTES) throw new Error('optical.tooLarge')
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}
