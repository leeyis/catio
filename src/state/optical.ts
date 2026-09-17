import { useSyncExternalStore } from 'react'
import { opticalCheck, opticalLock } from '../services/optical'

// Capability stays in memory: never localStorage, config export, history or model context.
let token: string | null = null
let revision = 0
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => token
export const useOpticalToken = () => useSyncExternalStore(subscribe, snapshot, () => null)
export const opticalRevision = () => revision

export function setOpticalToken(value: string | null) {
  revision++
  token = value
  if (timer) clearInterval(timer)
  timer = undefined
  if (value) {
    timer = setInterval(() => {
      void opticalCheck(value).then(valid => {
        if (!valid && token === value) void lockOptical()
      }).catch(() => { if (token === value) void lockOptical() })
    }, 15_000)
  }
  listeners.forEach(fn => fn())
}
export async function lockOptical() {
  const previous = token
  setOpticalToken(null) // stop playback immediately, even if the backend is unavailable
  if (previous) await opticalLock(previous).catch(() => {})
}
