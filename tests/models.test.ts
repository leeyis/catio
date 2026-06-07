import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentConfig } from '../src/state/agentConfig'
import { fetchModels } from '../src/services/models'

// In jsdom, window.__TAURI_INTERNALS__ is not set, so isTauri = false
// and fetchModels will use globalThis.fetch — perfect for mocking.

const BASE_OLLAMA_CFG: AgentConfig = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com',
  openaiKey: '',
  model: '',
}

const BASE_OPENAI_CFG: AgentConfig = {
  provider: 'openai',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com',
  openaiKey: 'sk-test-key',
  model: '',
}

function makeFetchMock(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
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

  it('trims trailing slash from ollamaBaseUrl', async () => {
    const body = { models: [{ name: 'phi3' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels({ ...BASE_OLLAMA_CFG, ollamaBaseUrl: 'http://localhost:11434/' })
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

    await fetchModels({ ...BASE_OPENAI_CFG, openaiKey: '' })
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

  it('trims trailing slash from openaiBaseUrl', async () => {
    const body = { data: [{ id: 'gpt-4o' }] }
    const mockFetch = makeFetchMock(200, body)
    vi.stubGlobal('fetch', mockFetch)

    await fetchModels({ ...BASE_OPENAI_CFG, openaiBaseUrl: 'https://api.openai.com/' })
    const callArgs = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(callArgs[0]).toBe('https://api.openai.com/v1/models')
  })

  it('throws on non-2xx OpenAI response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, {}))
    await expect(fetchModels(BASE_OPENAI_CFG)).rejects.toThrow('OpenAI fetch failed: 401')
  })
})
