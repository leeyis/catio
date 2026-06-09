// Agent configuration state with localStorage persistence.
// NOTE: openaiKey is stored in localStorage in plaintext for this UI-shell stage.
// Real OS keychain encryption (Tauri stronghold / Windows Credential Manager) is a later sub-project.
//
// Backed by a tiny subscribable store (module-level state + listeners) so every
// consumer shares one source of truth: changing the provider/model in Settings
// reaches App's send-path live, without a reload. Mirrors state/preferences.ts.

import { useSyncExternalStore } from 'react'

export type ModelProvider = 'ollama' | 'openai'

export interface AgentConfig {
  provider: ModelProvider
  ollamaBaseUrl: string  // default 'http://localhost:11434'
  openaiBaseUrl: string  // default 'https://api.openai.com'
  openaiKey: string      // default ''
  model: string          // selected model id, default ''
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com',
  openaiKey: '',
  model: '',
}

const STORAGE_KEY = 'catio-agent-config'

function readFromStorage(): AgentConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AGENT_CONFIG }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AGENT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AgentConfig>
    return { ...DEFAULT_AGENT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_AGENT_CONFIG }
  }
}

function writeToStorage(cfg: AgentConfig): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch { /* ignore quota errors */ }
}

// ---- Subscribable store ----

let state: AgentConfig = readFromStorage()
const listeners = new Set<() => void>()

export function getAgentConfig(): AgentConfig {
  return state
}

export function setAgentConfig(patch: Partial<AgentConfig>): void {
  state = { ...state, ...patch }
  writeToStorage(state)
  listeners.forEach(l => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  // When the store goes idle → active (first mount), re-sync from localStorage so
  // a fresh mount reflects the current persisted value. This preserves the old
  // "read on mount" semantics (and test isolation under localStorage.clear())
  // while keeping a single live store between mounts. At runtime App is always
  // mounted, so this never clobbers in-session edits.
  if (listeners.size === 1) {
    const fresh = readFromStorage()
    if (JSON.stringify(fresh) !== JSON.stringify(state)) {
      state = fresh
      listeners.forEach(l => l())
    }
  }
  return () => { listeners.delete(cb) }
}

/**
 * Clear every secret persisted on this machine. SSH/DB passwords are never
 * stored (they are prompted per-connect and held only in memory), so the only
 * at-rest credential is the Agent API key — blank it while keeping the rest of
 * the agent config (provider / endpoints / model) intact.
 */
export function clearStoredCredentials(): void {
  setAgentConfig({ openaiKey: '' })
}

// ---- Hook ----

export function useAgentConfig(): { config: AgentConfig; update: (patch: Partial<AgentConfig>) => void } {
  const config = useSyncExternalStore(subscribe, getAgentConfig, getAgentConfig)
  return { config, update: setAgentConfig }
}
