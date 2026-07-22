import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentConfig } from '../src/state/agentConfig'
import { fetchModels, testModel } from '../src/services/models'

// In jsdom, window.__TAURI_INTERNALS__ is not set, so isTauri = false
// and fetchModels will use globalThis.fetch — perfect for mocking.

const BASE_OLLAMA_CFG: AgentConfig = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  anthropicAuthMode: 'api-key',
  model: '',
  executionMode: 'manual',
  singleLineCommands: true,
  maxShellSteps: 8,
}

const BASE_OPENAI_CFG: AgentConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test-key',
  anthropicAuthMode: 'api-key',
  model: '',
  executionMode: 'manual',
  singleLineCommands: true,
  maxShellSteps: 8,
}

const BASE_DEEPSEEK_CFG: AgentConfig = {
  ...BASE_OPENAI_CFG,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
}

const BASE_ZHIPU_CFG: AgentConfig = {
  ...BASE_OPENAI_CFG,
  provider: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
}

const BASE_KIMI_CFG: AgentConfig = {
  ...BASE_OPENAI_CFG,
  provider: 'kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
}

const BASE_ANTHROPIC_CFG: AgentConfig = {
  ...BASE_OPENAI_CFG,
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
}

function makeFetchResponse(status: number, body: unknown, textBody = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => textBody,
  } as Response
}

function makeFetchMock(status: number, body: unknown, textBody = ''): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(makeFetchResponse(status, body, textBody)) as unknown as typeof globalThis.fetch
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchModels — Ollama', () => {
  it('parses Ollama /api/tags response and returns model names', async () => {
    const body = { models: [{ name: 'llama3:8b' }, { name: 'mistral:7b' }] }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    const result = await fetchModels(BASE_OLLAMA_CFG)
    expect(result).toEqual(['llama3:8b', 'mistral:7b'])
  })

  it('calls the correct Ollama URL', async () => {
    const body = { models: [{ name: 'phi3' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels(BASE_OLLAMA_CFG)
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags')
  })

  it('trims trailing slash from the Ollama base URL', async () => {
    const body = { models: [{ name: 'phi3' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels({ ...BASE_OLLAMA_CFG, baseUrl: 'http://localhost:11434/' })
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags')
  })

  it('throws on non-2xx Ollama response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(500, {}))
    await expect(fetchModels(BASE_OLLAMA_CFG)).rejects.toThrow('Ollama fetch failed: 500')
  })
})

describe('fetchModels — OpenAI-compatible', () => {
  it('parses OpenAI /v1/models response and returns sorted ids', async () => {
    const body = { data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'gpt-4-turbo' }] }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    const result = await fetchModels(BASE_OPENAI_CFG)
    expect(result).toEqual(['gpt-3.5-turbo', 'gpt-4-turbo', 'gpt-4o'])
  })

  it('sends Authorization header when key is provided', async () => {
    const body = { data: [{ id: 'gpt-4o' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels(BASE_OPENAI_CFG)
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = callArgs[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test-key')
  })

  it('does NOT send Authorization header when key is empty', async () => {
    const body = { data: [{ id: 'gpt-4o' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels({ ...BASE_OPENAI_CFG, apiKey: '' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = callArgs[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('calls the correct OpenAI URL', async () => {
    const body = { data: [{ id: 'gpt-4o' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels(BASE_OPENAI_CFG)
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(callArgs[0]).toBe('https://api.openai.com/v1/models')
  })

  it('trims trailing slash from the OpenAI base URL', async () => {
    const body = { data: [{ id: 'gpt-4o' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels({ ...BASE_OPENAI_CFG, baseUrl: 'https://api.openai.com/' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(callArgs[0]).toBe('https://api.openai.com/v1/models')
  })

  it('throws on non-2xx OpenAI response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, {}))
    await expect(fetchModels(BASE_OPENAI_CFG)).rejects.toThrow('OpenAI fetch failed: 401')
  })

  it('follows cursor pagination and returns every unique model', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse(200, {
        data: [{ id: 'model-b' }, { id: 'model-a' }],
        has_more: true,
        last_id: 'model-b',
      }))
      .mockResolvedValueOnce(makeFetchResponse(200, {
        data: [{ id: 'model-c' }, { id: 'model-b' }],
        has_more: false,
      }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchModels(BASE_OPENAI_CFG)).resolves.toEqual(['model-a', 'model-b', 'model-c'])
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.openai.com/v1/models?after_id=model-b')
  })

  it('rejects malformed model entries instead of returning undefined names', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200, { data: [{ name: 'missing-id' }] }))
    await expect(fetchModels(BASE_OPENAI_CFG)).rejects.toThrow('Model response format unexpected')
  })
})

describe('fetchModels — provider presets', () => {
  it('uses DeepSeek official paths without adding /v1', async () => {
    const mockFetch = makeFetchMock(200, { data: [{ id: 'deepseek-v4-pro' }] })
    vi.stubGlobal('fetch', mockFetch)
    await fetchModels(BASE_DEEPSEEK_CFG)
    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://api.deepseek.com/models')
  })

  it('uses Anthropic model endpoint and x-api-key headers', async () => {
    const mockFetch = makeFetchMock(200, { data: [{ id: 'claude-opus-4-6' }] })
    vi.stubGlobal('fetch', mockFetch)
    expect(await fetchModels(BASE_ANTHROPIC_CFG)).toEqual(['claude-opus-4-6'])
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test')
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01')
  })

  it('uses the discovered Zhipu models and keeps a manually entered model', async () => {
    const mockFetch = makeFetchMock(200, { data: [{ id: 'glm-5' }, { id: 'custom-glm' }] })
    vi.stubGlobal('fetch', mockFetch)
    const result = await fetchModels({ ...BASE_ZHIPU_CFG, model: 'manual-glm' })
    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://open.bigmodel.cn/api/paas/v4/models')
    expect(result).toEqual(['custom-glm', 'glm-5', 'manual-glm'])
  })

  it('falls back to the Zhipu catalog when model discovery is unavailable', async () => {
    vi.stubGlobal('fetch', makeFetchMock(404, {}))
    await expect(fetchModels(BASE_ZHIPU_CFG)).resolves.toEqual([
      'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flashx',
      'glm-4.6', 'glm-4.5-air',
    ])
  })

  it('does not hide a Zhipu authentication failure behind the fallback catalog', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, {}))
    await expect(fetchModels(BASE_ZHIPU_CFG)).rejects.toThrow('Zhipu fetch failed: 401')
  })

  it('uses the Kimi /v1 model endpoint', async () => {
    const mockFetch = makeFetchMock(200, { data: [{ id: 'kimi-k2.5' }] })
    vi.stubGlobal('fetch', mockFetch)
    await fetchModels(BASE_KIMI_CFG)
    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://api.moonshot.cn/v1/models')
  })

  it('detects a Claude Code OAuth token without asking for an auth mode', async () => {
    const mockFetch = makeFetchMock(200, { data: [{ id: 'claude-sonnet' }] })
    vi.stubGlobal('fetch', mockFetch)
    await fetchModels({ ...BASE_ANTHROPIC_CFG, apiKey: 'sk-ant-oat01-test' })
    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-ant-oat01-test' })
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined()
  })

  it('detects an official Anthropic API key in auto mode', async () => {
    const mockFetch = makeFetchMock(200, { data: [{ id: 'claude-sonnet' }] })
    vi.stubGlobal('fetch', mockFetch)
    await fetchModels({ ...BASE_ANTHROPIC_CFG, apiKey: 'sk-ant-api03-test', anthropicAuthMode: 'auto' })
    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant-api03-test' })
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('retries the alternate Anthropic auth header for a custom Claude Code endpoint', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse(401, {}))
      .mockResolvedValueOnce(makeFetchResponse(200, { data: [{ id: 'vendor-claude' }] }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchModels({
      ...BASE_ANTHROPIC_CFG,
      apiKey: 'vendor-key',
      anthropicAuthMode: 'auto',
    })).resolves.toEqual(['vendor-claude'])
    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer vendor-key' })
    expect(mockFetch.mock.calls[1][1].headers).toMatchObject({ 'x-api-key': 'vendor-key' })
  })
})

// ---- testModel ----

describe('testModel — empty model guard', () => {
  it('returns ok:false with error no-model and does NOT call fetch', async () => {
    const mockFetch = makeFetchMock(200, {})
    vi.stubGlobal('fetch', mockFetch)

    const result = await testModel({ ...BASE_OPENAI_CFG, model: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no-model')
    expect(result.latencyMs).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('testModel — OpenAI-compatible', () => {
  it('2xx with choices parses reply and returns ok:true', async () => {
    const body = { choices: [{ message: { content: 'pong' } }] }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    const result = await testModel({ ...BASE_OPENAI_CFG, model: 'gpt-4o' })
    expect(result.ok).toBe(true)
    expect(result.reply).toBe('pong')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('POSTs to /v1/chat/completions', async () => {
    const body = { choices: [{ message: { content: 'pong' } }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await testModel({ ...BASE_OPENAI_CFG, model: 'gpt-4o' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(callArgs[0]).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('sends Authorization header when key provided', async () => {
    const body = { choices: [{ message: { content: 'pong' } }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await testModel({ ...BASE_OPENAI_CFG, model: 'gpt-4o' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = callArgs[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test-key')
  })

  it('does NOT send Authorization header when key is empty', async () => {
    const body = { choices: [{ message: { content: 'pong' } }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await testModel({ ...BASE_OPENAI_CFG, model: 'gpt-4o', apiKey: '' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = callArgs[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('non-2xx returns ok:false with error containing status', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, {}))

    const result = await testModel({ ...BASE_OPENAI_CFG, model: 'gpt-4o' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('2xx with an unexpected payload is not reported as a successful model test', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200, { ok: true }))
    await expect(testModel({ ...BASE_OPENAI_CFG, model: 'gpt-4o' })).resolves.toMatchObject({
      ok: false,
      error: 'unexpected-response',
    })
  })
})

describe('testModel — Ollama', () => {
  it('2xx with message.content parses reply and returns ok:true', async () => {
    const body = { message: { content: 'pong' } }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    const result = await testModel({ ...BASE_OLLAMA_CFG, model: 'llama3:8b' })
    expect(result.ok).toBe(true)
    expect(result.reply).toBe('pong')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('POSTs to /api/chat', async () => {
    const body = { message: { content: 'pong' } }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await testModel({ ...BASE_OLLAMA_CFG, model: 'llama3:8b' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(callArgs[0]).toBe('http://localhost:11434/api/chat')
  })

  it('non-2xx returns ok:false with error containing status', async () => {
    vi.stubGlobal('fetch', makeFetchMock(500, {}))

    const result = await testModel({ ...BASE_OLLAMA_CFG, model: 'llama3:8b' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })
})

describe('testModel — Anthropic', () => {
  it('POSTs a native Messages API body and parses text content', async () => {
    const mockFetch = makeFetchMock(200, { content: [{ type: 'text', text: 'pong' }] })
    vi.stubGlobal('fetch', mockFetch)
    const result = await testModel({ ...BASE_ANTHROPIC_CFG, model: 'claude-opus-4-6' })
    expect(result).toMatchObject({ ok: true, reply: 'pong' })
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'claude-opus-4-6', max_tokens: 16, stream: false })
  })
})
