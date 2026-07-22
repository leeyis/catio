import { MODEL_PROVIDER_PRESETS, type AgentConfig } from '../state/agentConfig'

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

/** Append `/v1` for native OpenAI/Anthropic endpoints while preserving custom
 * versioned endpoints and DeepSeek's official unversioned base URL. */
export function providerApiBase(cfg: AgentConfig): string {
  const base = trimSlash(cfg.baseUrl)
  if (cfg.provider === 'ollama' || cfg.provider === 'deepseek' || /\/v1$/i.test(base)) return base
  return `${base}/v1`
}

export function apiHeaders(cfg: AgentConfig, json = false): Record<string, string> {
  const protocol = MODEL_PROVIDER_PRESETS[cfg.provider].protocol
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {}
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (cfg.apiKey) {
      if (cfg.anthropicAuthMode === 'auth-token') headers['Authorization'] = `Bearer ${cfg.apiKey}`
      else headers['x-api-key'] = cfg.apiKey
    }
  } else if (protocol === 'openai' && cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  }
  return headers
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

interface AnthropicChatResponse {
  content: Array<{ type: string; text?: string }>
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

function isAnthropicChatResponse(v: unknown): v is AnthropicChatResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'content' in v &&
    Array.isArray((v as AnthropicChatResponse).content)
  )
}

export async function testModel(cfg: AgentConfig): Promise<ModelTestResult> {
  if (!cfg.model) {
    return { ok: false, latencyMs: 0, error: 'no-model' }
  }

  const fetcher = await resolveFetch()
  const start = Date.now()
  const protocol = MODEL_PROVIDER_PRESETS[cfg.provider].protocol

  try {
    if (protocol === 'ollama') {
      const base = trimSlash(cfg.baseUrl)
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

    const base = providerApiBase(cfg)
    const url = protocol === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`
    const headers = apiHeaders(cfg, true)
    const body = protocol === 'anthropic'
      ? JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false })
      : JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, temperature: 0, stream: false })
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
    const reply = protocol === 'anthropic'
      ? (isAnthropicChatResponse(json) ? json.content.find(block => block.type === 'text')?.text : undefined)
      : (isOpenAIChatResponse(json) ? json.choices[0].message.content : undefined)
    return { ok: true, latencyMs, reply }
  } catch (err) {
    const latencyMs = Date.now() - start
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, latencyMs, error: message }
  }
}

export async function fetchModels(cfg: AgentConfig): Promise<string[]> {
  const fetcher = await resolveFetch()
  const protocol = MODEL_PROVIDER_PRESETS[cfg.provider].protocol

  if (protocol === 'ollama') {
    const base = trimSlash(cfg.baseUrl)
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

  const url = `${providerApiBase(cfg)}/models`
  const headers = apiHeaders(cfg)
  const resp = await fetcher(url, { headers })
  if (!resp.ok) {
    const providerName = cfg.provider === 'deepseek' ? 'DeepSeek' : cfg.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
    throw new Error(`${providerName} fetch failed: ${resp.status} ${resp.statusText}`)
  }
  const json: unknown = await resp.json()
  if (!isOpenAIModelsResponse(json)) {
    throw new Error('Model response format unexpected')
  }
  return json.data.map(d => d.id).sort()
}
