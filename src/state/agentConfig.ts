// Agent configuration state with localStorage persistence.
// NOTE: openaiKey is stored in localStorage in plaintext for this UI-shell stage.
// Real OS keychain encryption (Tauri stronghold / Windows Credential Manager) is a later sub-project.

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

// ---- Hook ----

import { useState, useCallback } from 'react'

export function useAgentConfig(): { config: AgentConfig; update: (patch: Partial<AgentConfig>) => void } {
  const [config, setConfig] = useState<AgentConfig>(readFromStorage)

  const update = useCallback((patch: Partial<AgentConfig>) => {
    setConfig(prev => {
      const next: AgentConfig = { ...prev, ...patch }
      writeToStorage(next)
      return next
    })
  }, [])

  return { config, update }
}
