import { describe, it, expect, vi, beforeEach } from 'vitest'

function streamResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s))
      c.close()
    },
  })
  return new Response(body, { status })
}

beforeEach(() => {
  vi.restoreAllMocks()
  // Reset module registry so each test gets a fresh import (avoids cached resolveFetch)
  vi.resetModules()
})

describe('agent.chat', () => {
  it('ollama accumulates NDJSON tokens', async () => {
    const f = vi.fn().mockResolvedValue(
      streamResponse([
        '{"message":{"content":"Hel"}}\n',
        '{"message":{"content":"lo"},"done":false}\n',
        '{"done":true}\n',
      ]),
    )
    vi.stubGlobal('fetch', f)
    const { chat } = await import('./agent')
    let acc = ''
    const out = await chat(
      [{ role: 'user', content: 'hi' }],
      { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' },
      { onToken: t => { acc += t } },
    )
    expect(out).toBe('Hello')
    expect(acc).toBe('Hello')
  })

  it('openai parses SSE deltas and stops at [DONE]', async () => {
    const f = vi.fn().mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    vi.stubGlobal('fetch', f)
    const { chat } = await import('./agent')
    const out = await chat(
      [{ role: 'user', content: 'hi' }],
      { provider: 'openai', ollamaBaseUrl: '', openaiBaseUrl: 'http://h', openaiKey: 'k', model: 'm' },
    )
    expect(out).toBe('AB')
    // assert Authorization header was sent
    const init = f.mock.calls[0][1] as Record<string, Record<string, string>>
    expect(
      init.headers['Authorization'] ?? init.headers['authorization'],
    ).toBe('Bearer k')
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(['bad'], 500)))
    const { chat } = await import('./agent')
    await expect(
      chat(
        [{ role: 'user', content: 'x' }],
        { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' },
      ),
    ).rejects.toThrow(/500/)
  })

  it('handles tokens split across chunks', async () => {
    // A newline-delimited JSON line that arrives in two separate chunks
    const f = vi.fn().mockResolvedValue(
      streamResponse([
        '{"message":{"content":"split"',
        '}}\n{"done":true}\n',
      ]),
    )
    vi.stubGlobal('fetch', f)
    const { chat } = await import('./agent')
    const out = await chat(
      [{ role: 'user', content: 'hi' }],
      { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' },
    )
    expect(out).toBe('split')
  })

  it('openai: no Authorization header when key is empty', async () => {
    const f = vi.fn().mockResolvedValue(
      streamResponse(['data: [DONE]\n\n']),
    )
    vi.stubGlobal('fetch', f)
    const { chat } = await import('./agent')
    await chat(
      [{ role: 'user', content: 'hi' }],
      { provider: 'openai', ollamaBaseUrl: '', openaiBaseUrl: 'http://h', openaiKey: '', model: 'm' },
    )
    const init = f.mock.calls[0][1] as Record<string, Record<string, string>>
    expect(
      init.headers['Authorization'] ?? init.headers['authorization'],
    ).toBeUndefined()
  })
})
