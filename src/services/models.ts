import type { AgentConfig } from '../state/agentConfig'

// ---- Tauri guard (same pattern as src/components/shell/Sidebar.tsx) ----
const isTauri: boolean =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// ---- Minimal typed response shapes (no `any`) ----

interface OllamaTagsResponse {
  models: Array<{ name: string }>
}

interface OpenAIModelsResponse {
  data: Array<{ id: string }>
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function isOllamaTagsResponse(v: unknown): v is OllamaTagsResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'models' in v &&
    Array.isArray((v as OllamaTagsResponse).models)
  )
}

function isOpenAIModelsResponse(v: unknown): v is OpenAIModelsResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'data' in v &&
    Array.isArray((v as OpenAIModelsResponse).data)
  )
}

// Resolve the fetch function: use Tauri HTTP plugin in Tauri context (bypasses CORS),
// fall back to globalThis.fetch for browser/jsdom (works for same-origin/localhost).
async function resolveFetch(): Promise<typeof globalThis.fetch> {
  if (isTauri) {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
      return tauriFetch as typeof globalThis.fetch
    } catch {
      // Plugin not available; fall back to global fetch
    }
  }
  return globalThis.fetch.bind(globalThis)
}

export async function fetchModels(cfg: AgentConfig): Promise<string[]> {
  const fetcher = await resolveFetch()

  if (cfg.provider === 'ollama') {
    const base = trimSlash(cfg.ollamaBaseUrl)
    const url = `${base}/api/tags`
    const resp = await fetcher(url)
    if (!resp.ok) {
      throw new Error(`Ollama fetch failed: ${resp.status} ${resp.statusText}`)
    }
    const json: unknown = await resp.json()
    if (!isOllamaTagsResponse(json)) {
      throw new Error('Ollama response format unexpected')
    }
    return json.models.map(m => m.name)
  }

  // OpenAI-compatible
  const base = trimSlash(cfg.openaiBaseUrl)
  const url = `${base}/v1/models`
  const headers: Record<string, string> = {}
  if (cfg.openaiKey) {
    headers['Authorization'] = `Bearer ${cfg.openaiKey}`
  }
  const resp = await fetcher(url, { headers })
  if (!resp.ok) {
    throw new Error(`OpenAI fetch failed: ${resp.status} ${resp.statusText}`)
  }
  const json: unknown = await resp.json()
  if (!isOpenAIModelsResponse(json)) {
    throw new Error('OpenAI response format unexpected')
  }
  return json.data.map(d => d.id).sort()
}
