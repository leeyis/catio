import { useSyncExternalStore } from 'react'
import { configureLocalWorkspace } from '../services/localFiles'
import { isTauri } from '../services/transport'

// Device-local and account-scoped; absent from configSync's allowlist.
const key = (owner: string) => `catio-agent-workspace:${encodeURIComponent(owner)}`
let scope: string | null = typeof localStorage !== 'undefined' && localStorage.getItem('catio-auth') === '1' ? null : '__open'
function readPath(): string {
  if (!scope || typeof localStorage === 'undefined') return ''
  try { return localStorage.getItem(key(scope)) ?? '' } catch { return '' }
}
let path = readPath()
let activePath: string | null = null
let epoch = 0
let queue: Promise<unknown> = Promise.resolve()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(fn => fn())
function serial<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run, run)
  queue = result.catch(() => {})
  return result
}

export function getAgentWorkspacePath(): string { return path }

/** Lock/account switch revokes backend grants, including active Turn snapshots. */
export function setAgentWorkspaceScope(owner: string | null, reset = false): void {
  if (scope === owner && !reset) return
  scope = owner
  epoch++
  activePath = null
  path = readPath()
  emit()
  if (isTauri()) void serial(() => configureLocalWorkspace(null)).catch(() => {})
}

export async function saveAgentWorkspace(value: string): Promise<void> {
  const owner = scope
  const generation = epoch
  if (!owner) throw new Error('workspaceLocked')
  await serial(async () => {
    if (scope !== owner || epoch !== generation) throw new Error('workspaceLocked')
    const previous = path
    const normalized = await configureLocalWorkspace(value.trim() || null)
    if (scope !== owner || epoch !== generation) throw new Error('workspaceLocked')
    try {
      if (normalized) localStorage.setItem(key(owner), normalized)
      else localStorage.removeItem(key(owner))
    } catch {
      await configureLocalWorkspace(previous || null)
      throw new Error('workspacePersistenceFailed')
    }
    path = normalized ?? ''
    activePath = normalized
    emit()
  })
}

/** Restore a saved directory only when the user starts an enabled Agent Turn. */
export async function prepareAgentWorkspace(): Promise<string | null> {
  if (!isTauri()) return null
  const owner = scope
  const generation = epoch
  return serial(async () => {
    if (!owner || scope !== owner || epoch !== generation) throw new Error('workspaceLocked')
    if (!path) return null
    if (activePath !== path) activePath = await configureLocalWorkspace(path)
    if (scope !== owner || epoch !== generation) throw new Error('workspaceLocked')
    return activePath
  })
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  const stored = readPath()
  if (stored !== path) { path = stored; activePath = null; emit() }
  return () => { listeners.delete(fn) }
}
export function useAgentWorkspace(): string {
  return useSyncExternalStore(subscribe, getAgentWorkspacePath, getAgentWorkspacePath)
}
