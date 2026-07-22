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
}

const BASE_OPENAI_CFG: AgentConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test-key',
  anthropicAuthMode: 'api-key',
  model: '',
  executionMode: 'manual',
}

const BASE_DEEPSEEK_CFG: AgentConfig = {
  ...BASE_OPENAI_CFG,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
}

const BASE_ANTHROPIC_CFG: AgentConfig = {
  ...BASE_OPENAI_CFG,
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
}

function makeFetchMock(status: number, body: unknown, textBody = ''): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => textBody,
  }) as unknown as typeof globalThis.fetch
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
})

describe('fetchModels — DeepSeek and Anthropic', () => {
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
