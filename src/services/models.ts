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

export function trimSlash(url: string): string {
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
export async function resolveFetch(): Promise<typeof globalThis.fetch> {
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

// ---- testModel ----

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  reply?: string
  error?: string
}

interface OllamaChatResponse {
  message: { content: string }
}

interface OpenAIChatResponse {
  choices: Array<{ message: { content: string } }>
}

function isOllamaChatResponse(v: unknown): v is OllamaChatResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'message' in v &&
    typeof (v as OllamaChatResponse).message?.content === 'string'
  )
}

function isOpenAIChatResponse(v: unknown): v is OpenAIChatResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'choices' in v &&
    Array.isArray((v as OpenAIChatResponse).choices) &&
    typeof (v as OpenAIChatResponse).choices[0]?.message?.content === 'string'
  )
}

export async function testModel(cfg: AgentConfig): Promise<ModelTestResult> {
  if (!cfg.model) {
    return { ok: false, latencyMs: 0, error: 'no-model' }
  }

  const fetcher = await resolveFetch()
  const start = Date.now()

  try {
    if (cfg.provider === 'ollama') {
      const base = trimSlash(cfg.ollamaBaseUrl)
      const url = `${base}/api/chat`
      const body = JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      })
      const resp = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const latencyMs = Date.now() - start
      if (!resp.ok) {
        let detail = ''
        try {
          const text = await resp.text()
          detail = text.slice(0, 140)
        } catch { /* ignore */ }
        return { ok: false, latencyMs, error: `HTTP ${resp.status}${detail ? ': ' + detail : ''}` }
      }
      const json: unknown = await resp.json()
      const reply = isOllamaChatResponse(json) ? json.message.content : undefined
      return { ok: true, latencyMs, reply }
    }

    // OpenAI-compatible
    const base = trimSlash(cfg.openaiBaseUrl)
    const url = `${base}/v1/chat/completions`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.openaiKey) {
      headers['Authorization'] = `Bearer ${cfg.openaiKey}`
    }
    const body = JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      temperature: 0,
      stream: false,
    })
    const resp = await fetcher(url, { method: 'POST', headers, body })
    const latencyMs = Date.now() - start
    if (!resp.ok) {
      let detail = ''
      try {
        const text = await resp.text()
        detail = text.slice(0, 140)
      } catch { /* ignore */ }
      return { ok: false, latencyMs, error: `HTTP ${resp.status}${detail ? ': ' + detail : ''}` }
    }
    const json: unknown = await resp.json()
    const reply = isOpenAIChatResponse(json) ? json.choices[0].message.content : undefined
    return { ok: true, latencyMs, reply }
  } catch (err) {
    const latencyMs = Date.now() - start
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, latencyMs, error: message }
  }
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
