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
  has_more?: boolean
  last_id?: string | null
}

const MAX_MODEL_PAGES = 50

const BUILT_IN_MODELS: Partial<Record<AgentConfig['provider'], readonly string[]>> = {
  zhipu: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.6', 'glm-4.5-air'],
}

function mergeModelNames(cfg: AgentConfig, remote: string[], includeBuiltIns = false): string[] {
  const current = cfg.model ? [cfg.model] : []
  const builtIns = includeBuiltIns ? BUILT_IN_MODELS[cfg.provider] ?? [] : []
  return [...new Set([...builtIns, ...remote, ...current])]
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Append `/v1` for native OpenAI/Anthropic endpoints while preserving provider
 * endpoints that already include their API version. */
export function providerApiBase(cfg: AgentConfig): string {
  const base = trimSlash(cfg.baseUrl)
  if (cfg.provider === 'ollama' || cfg.provider === 'deepseek' || cfg.provider === 'zhipu' || /\/v1$/i.test(base)) return base
  return `${base}/v1`
}

export function apiHeaders(cfg: AgentConfig, json = false): Record<string, string> {
  const protocol = MODEL_PROVIDER_PRESETS[cfg.provider].protocol
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {}
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (cfg.apiKey) {
      const bearer = cfg.anthropicAuthMode === 'auth-token' || /^sk-ant-oat/i.test(cfg.apiKey)
        || (cfg.anthropicAuthMode === 'auto' && !/^sk-ant-api/i.test(cfg.apiKey))
      if (bearer) headers['Authorization'] = `Bearer ${cfg.apiKey}`
      else headers['x-api-key'] = cfg.apiKey
    }
  } else if (protocol === 'openai' && cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  }
  return headers
}

export async function fetchWithAuthFallback(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  cfg: AgentConfig,
): Promise<Response> {
  const response = await fetcher(url, init)
  if (
    MODEL_PROVIDER_PRESETS[cfg.provider].protocol !== 'anthropic'
    || !cfg.apiKey
    || (response.status !== 401 && response.status !== 403)
  ) return response

  try { await response.body?.cancel() } catch { /* best-effort before retry */ }
  const headers = { ...(init.headers as Record<string, string> | undefined) }
  if (headers.Authorization) {
    delete headers.Authorization
    headers['x-api-key'] = cfg.apiKey
  } else {
    delete headers['x-api-key']
    headers.Authorization = `Bearer ${cfg.apiKey}`
  }
  return fetcher(url, { ...init, headers })
}

function isOllamaTagsResponse(v: unknown): v is OllamaTagsResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'models' in v &&
    Array.isArray((v as OllamaTagsResponse).models) &&
    (v as OllamaTagsResponse).models.every(model => typeof model?.name === 'string' && model.name.length > 0)
  )
}

function isOpenAIModelsResponse(v: unknown): v is OpenAIModelsResponse {
  if (typeof v !== 'object' || v === null || !('data' in v)) return false
  const candidate = v as OpenAIModelsResponse
  if (!Array.isArray(candidate.data) || !candidate.data.every(model => typeof model?.id === 'string' && model.id.length > 0)) return false
  if (candidate.has_more !== undefined && typeof candidate.has_more !== 'boolean') return false
  return candidate.last_id === undefined || candidate.last_id === null || typeof candidate.last_id === 'string'
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
    Array.isArray((v as AnthropicChatResponse).content) &&
    (v as AnthropicChatResponse).content.every(block => (
      typeof block === 'object' && block !== null && typeof block.type === 'string'
      && (block.text === undefined || typeof block.text === 'string')
    ))
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
      if (!isOllamaChatResponse(json)) return { ok: false, latencyMs, error: 'unexpected-response' }
      return { ok: true, latencyMs, reply: json.message.content }
    }

    const base = providerApiBase(cfg)
    const url = protocol === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`
    const headers = apiHeaders(cfg, true)
    const body = protocol === 'anthropic'
      ? JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false })
      : JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, temperature: 0, stream: false })
    const resp = await fetchWithAuthFallback(fetcher, url, { method: 'POST', headers, body }, cfg)
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
    return typeof reply === 'string'
      ? { ok: true, latencyMs, reply }
      : { ok: false, latencyMs, error: 'unexpected-response' }
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
    return mergeModelNames(cfg, json.models.map(m => m.name))
  }

  const modelUrl = `${providerApiBase(cfg)}/models`
  const headers = apiHeaders(cfg)
  const modelIds: string[] = []
  const seenCursors = new Set<string>()
  let url = modelUrl

  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const resp = await fetchWithAuthFallback(fetcher, url, { headers }, cfg)
    if (!resp.ok) {
      // Zhipu's general API does not consistently expose model discovery. Only an
      // explicitly unsupported first page gets the local catalog; auth, network,
      // and pagination failures remain visible.
      if (page === 0 && cfg.provider === 'zhipu' && (resp.status === 404 || resp.status === 405)) {
        return mergeModelNames(cfg, [], true)
      }
      const providerName = {
        ollama: 'Ollama',
        openai: 'OpenAI',
        deepseek: 'DeepSeek',
        zhipu: 'Zhipu',
        kimi: 'Kimi',
        anthropic: 'Anthropic',
      }[cfg.provider]
      throw new Error(`${providerName} fetch failed: ${resp.status} ${resp.statusText}`)
    }

    const json: unknown = await resp.json()
    if (!isOpenAIModelsResponse(json)) throw new Error('Model response format unexpected')
    modelIds.push(...json.data.map(model => model.id))
    if (!json.has_more) return mergeModelNames(cfg, modelIds.sort())

    const cursor = json.last_id ?? json.data[json.data.length - 1]?.id
    if (!cursor || seenCursors.has(cursor)) throw new Error('Model pagination response unexpected')
    seenCursors.add(cursor)
    url = `${modelUrl}${modelUrl.includes('?') ? '&' : '?'}after_id=${encodeURIComponent(cursor)}`
  }

  throw new Error('Model pagination exceeded the safety limit')
}
