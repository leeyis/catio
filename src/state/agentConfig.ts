// Agent configuration state with localStorage persistence.
// NOTE: apiKey is stored in localStorage in plaintext for this UI-shell stage.
// Real OS keychain encryption (Tauri stronghold / Windows Credential Manager) is a later sub-project.
//
// Backed by a tiny subscribable store (module-level state + listeners) so every
// consumer shares one source of truth: changing the provider/model in Settings
// reaches App's send-path live, without a reload. Mirrors state/preferences.ts.

import { useSyncExternalStore } from 'react'

export type ModelProvider = 'ollama' | 'openai' | 'deepseek' | 'zhipu' | 'kimi' | 'anthropic'
export type ModelProtocol = 'ollama' | 'openai' | 'anthropic'
export type AnthropicAuthMode = 'auto' | 'api-key' | 'auth-token'
export type AgentExecutionMode = 'manual' | 'ask' | 'auto'

export interface ModelProviderPreset {
  protocol: ModelProtocol
  defaultBaseUrl: string
}

export const MODEL_PROVIDER_PRESETS: Record<ModelProvider, ModelProviderPreset> = {
  ollama: { protocol: 'ollama', defaultBaseUrl: 'http://localhost:11434' },
  openai: { protocol: 'openai', defaultBaseUrl: 'https://api.openai.com' },
  deepseek: { protocol: 'openai', defaultBaseUrl: 'https://api.deepseek.com' },
  zhipu: { protocol: 'openai', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  kimi: { protocol: 'openai', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  anthropic: { protocol: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com' },
}

export const MODEL_PROVIDER_ORDER: ModelProvider[] = ['ollama', 'deepseek', 'zhipu', 'kimi', 'openai', 'anthropic']

export interface AgentConfig {
  provider: ModelProvider
  baseUrl: string
  apiKey: string
  anthropicAuthMode: AnthropicAuthMode
  model: string
  executionMode: AgentExecutionMode
  singleLineCommands: boolean
  maxShellSteps: number
}

export const DEFAULT_AGENT_SHELL_STEPS = 8
export const MIN_AGENT_SHELL_STEPS = 1
export const MAX_AGENT_SHELL_STEPS = 20

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: 'deepseek',
  baseUrl: MODEL_PROVIDER_PRESETS.deepseek.defaultBaseUrl,
  apiKey: '',
  anthropicAuthMode: 'auto',
  model: '',
  executionMode: 'manual',
  singleLineCommands: true,
  maxShellSteps: DEFAULT_AGENT_SHELL_STEPS,
}

const STORAGE_KEY = 'catio-agent-config'

function readFromStorage(): AgentConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AGENT_CONFIG }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AGENT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<AgentConfig> & {
      ollamaBaseUrl?: unknown
      openaiBaseUrl?: unknown
      openaiKey?: unknown
    }
    const provider = MODEL_PROVIDER_ORDER.includes(parsed.provider as ModelProvider)
      ? parsed.provider as ModelProvider
      : DEFAULT_AGENT_CONFIG.provider
    const legacyBaseUrl = provider === 'ollama' ? parsed.ollamaBaseUrl : parsed.openaiBaseUrl
    return {
      provider,
      baseUrl: typeof parsed.baseUrl === 'string'
        ? parsed.baseUrl
        : typeof legacyBaseUrl === 'string'
          ? legacyBaseUrl
          : MODEL_PROVIDER_PRESETS[provider].defaultBaseUrl,
      apiKey: typeof parsed.apiKey === 'string'
        ? parsed.apiKey
        : typeof parsed.openaiKey === 'string' ? parsed.openaiKey : '',
      // The auth selector is intentionally hidden from novice users. Re-evaluate
      // old values through the key/token heuristic instead of preserving a stale
      // override that can no longer be changed in the UI.
      anthropicAuthMode: 'auto',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      // Execution permission is session-only. Restarting Catio always returns to
      // the safest default instead of preserving a stale Full Access grant.
      executionMode: 'manual',
      singleLineCommands: typeof parsed.singleLineCommands === 'boolean'
        ? parsed.singleLineCommands
        : DEFAULT_AGENT_CONFIG.singleLineCommands,
      maxShellSteps: typeof parsed.maxShellSteps === 'number' && Number.isFinite(parsed.maxShellSteps)
        ? Math.min(MAX_AGENT_SHELL_STEPS, Math.max(MIN_AGENT_SHELL_STEPS, Math.round(parsed.maxShellSteps)))
        : DEFAULT_AGENT_SHELL_STEPS,
    }
  } catch {
    return { ...DEFAULT_AGENT_CONFIG }
  }
}

function writeToStorage(cfg: AgentConfig): void {
  if (typeof localStorage === 'undefined') return
  try {
    const persisted: Omit<AgentConfig, 'executionMode'> = {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      anthropicAuthMode: cfg.anthropicAuthMode,
      model: cfg.model,
      singleLineCommands: cfg.singleLineCommands,
      maxShellSteps: cfg.maxShellSteps,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
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
  setAgentConfig({ apiKey: '' })
}

// ---- Hook ----

export function useAgentConfig(): { config: AgentConfig; update: (patch: Partial<AgentConfig>) => void } {
  const config = useSyncExternalStore(subscribe, getAgentConfig, getAgentConfig)
  return { config, update: setAgentConfig }
}
