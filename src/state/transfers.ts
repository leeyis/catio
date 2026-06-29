// Global SFTP transfer manager.
//
// Transfer state and the Tauri progress/complete/cancel/error listeners live here,
// at module scope — independent of any panel component. This is the fix for the
// bug where switching tabs or panels unmounted <SftpPanel/>, tearing down its
// listeners and dropping the in-flight upload/download from the UI (the backend
// task kept running, but the frontend lost all tracking). Now uploads/downloads
// continue and stay visible no matter which page or panel is shown; <SftpPanel/>
// merely subscribes to and renders this store.

import { useSyncExternalStore } from 'react'
import { sftpUpload, sftpDownload, sftpTransferCancel, sftpUploadWeb, listen } from '../services/ssh'
import type { TransferProgress } from '../services/types'

let webUploadSeq = 0

export interface Transfer {
  id: string
  filename: string
  percent: number
  /** Instantaneous transfer rate in bytes/sec (derived from progress deltas). */
  speed: number
  status: 'active' | 'error'
  kind: 'up' | 'down'
  /** Remote directory this transfer affects, so the open panel can refresh it. */
  dir: string
}

let transfers: Transfer[] = []
const subs = new Set<() => void>()
// last progress sample per transfer, for computing speed.
const sample: Record<string, { bytes: number; time: number }> = {}
// per-transfer listener cleanup, so cancel can stop listening immediately.
const cleanups: Record<string, () => void> = {}
// notified when an upload finishes, so the open panel can reload its listing.
const doneSubs = new Set<(dir: string, kind: 'up' | 'down') => void>()

function emit(): void {
  // New array reference so useSyncExternalStore sees a change.
  transfers = transfers.slice()
  subs.forEach(f => f())
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

function getSnapshot(): Transfer[] {
  return transfers
}

/** Subscribe a component to the live list of active transfers. */
export function useTransfers(): Transfer[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Subscribe to transfer completion; callback receives the affected remote dir + kind. */
export function onTransferDone(cb: (dir: string, kind: 'up' | 'down') => void): () => void {
  doneSubs.add(cb)
  return () => { doneSubs.delete(cb) }
}

async function track(id: string, filename: string, kind: 'up' | 'down', dir: string): Promise<void> {
  transfers = [...transfers, { id, filename, percent: 0, speed: 0, status: 'active', kind, dir }]
  emit()
  const offs: Array<() => void> = []
  const cleanup = () => { offs.forEach(f => f()); delete sample[id]; delete cleanups[id] }
  cleanups[id] = cleanup

  offs.push(await listen<TransferProgress>(`transfer-progress-${id}`, p => {
    const now = Date.now()
    const prev = sample[id]
    // Refresh the displayed speed at most once per second (otherwise it flickers
    // on every 256KiB progress event). The bar/percent still update every event.
    let nextSpeed: number | undefined
    if (!prev) {
      sample[id] = { bytes: p.bytesTransferred, time: now }
    } else if (now - prev.time >= 1000) {
      nextSpeed = (p.bytesTransferred - prev.bytes) / ((now - prev.time) / 1000)
      sample[id] = { bytes: p.bytesTransferred, time: now }
    }
    transfers = transfers.map(x => (x.id === id
      ? { ...x, percent: p.percent, speed: nextSpeed !== undefined ? nextSpeed : x.speed }
      : x))
    emit()
  }))

  const finish = () => {
    cleanup()
    transfers = transfers.filter(x => x.id !== id)
    emit()
    doneSubs.forEach(f => f(dir, kind))
  }
  offs.push(await listen(`transfer-complete-${id}`, finish))
  offs.push(await listen(`transfer-cancelled-${id}`, finish))
  offs.push(await listen<string>(`transfer-error-${id}`, () => {
    cleanup()
    transfers = transfers.map(x => (x.id === id ? { ...x, status: 'error' } : x))
    emit()
    // drop the errored row after a short delay
    setTimeout(() => { transfers = transfers.filter(x => x.id !== id); emit() }, 4000)
  }))
}

/** Start an upload and track it globally. Throws if the backend rejects the start. */
export async function startUpload(sessionId: string, localPath: string, remotePath: string, dir: string, filename: string): Promise<void> {
  const id = await sftpUpload(sessionId, localPath, remotePath)
  await track(id, filename, 'up', dir)
}

/** Start a download and track it globally. Throws if the backend rejects the start. */
export async function startDownload(sessionId: string, remotePath: string, dest: string, dir: string, filename: string): Promise<void> {
  const id = await sftpDownload(sessionId, remotePath, dest)
  await track(id, filename, 'down', dir)
}

/** Server-mode (browser) upload tracked in the same UI as desktop transfers. Progress + speed come
 *  from the XHR `upload.onprogress` (no Tauri events here); cancel aborts the POST. */
export async function startWebUpload(sessionId: string, remotePath: string, file: File, dir: string): Promise<void> {
  const id = `web-up-${(webUploadSeq += 1)}`
  const controller = new AbortController()
  cleanups[id] = () => controller.abort()
  transfers = [...transfers, { id, filename: file.name, percent: 0, speed: 0, status: 'active', kind: 'up', dir }]
  emit()
  try {
    await sftpUploadWeb(sessionId, remotePath, file, (loaded, total) => {
      const now = Date.now()
      const prev = sample[id]
      let nextSpeed: number | undefined
      if (!prev) sample[id] = { bytes: loaded, time: now }
      else if (now - prev.time >= 500) {
        nextSpeed = (loaded - prev.bytes) / ((now - prev.time) / 1000)
        sample[id] = { bytes: loaded, time: now }
      }
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
      transfers = transfers.map(x => (x.id === id ? { ...x, percent, speed: nextSpeed !== undefined ? nextSpeed : x.speed } : x))
      emit()
    }, controller.signal)
    // success → drop the row + notify the panel to refresh.
    delete sample[id]; delete cleanups[id]
    transfers = transfers.filter(x => x.id !== id)
    emit()
    doneSubs.forEach(f => f(dir, 'up'))
  } catch (e) {
    delete sample[id]; delete cleanups[id]
    if (e instanceof DOMException && e.name === 'AbortError') {
      transfers = transfers.filter(x => x.id !== id) // cancelled → just remove
      emit()
      return
    }
    transfers = transfers.map(x => (x.id === id ? { ...x, status: 'error' } : x))
    emit()
    setTimeout(() => { transfers = transfers.filter(x => x.id !== id); emit() }, 4000)
    throw e
  }
}

/** Cancel an in-flight transfer: stop the backend, stop listening, drop the row. */
export function cancelTransfer(id: string): void {
  if (!id.startsWith('web-up-')) sftpTransferCancel(id).catch(() => { /* best-effort */ })
  cleanups[id]?.()
  transfers = transfers.filter(x => x.id !== id)
  emit()
}
