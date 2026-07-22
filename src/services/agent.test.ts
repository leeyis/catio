import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig } from '../state/agentConfig'

const config = (patch: Partial<AgentConfig> = {}): AgentConfig => ({
  provider: 'ollama',
  baseUrl: 'http://h',
  apiKey: '',
  anthropicAuthMode: 'api-key',
  model: 'm',
  executionMode: 'manual',
  ...patch,
})

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
      config(),
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
      config({ provider: 'openai', apiKey: 'k' }),
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
        config(),
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
      config(),
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
      config({ provider: 'openai' }),
    )
    const init = f.mock.calls[0][1] as Record<string, Record<string, string>>
    expect(
      init.headers['Authorization'] ?? init.headers['authorization'],
    ).toBeUndefined()
  })

  it('deepseek uses its official chat path with bearer authentication', async () => {
    const f = vi.fn().mockResolvedValue(streamResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', f)
    const { chat } = await import('./agent')
    await chat(
      [{ role: 'user', content: 'hi' }],
      config({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key' }),
    )
    expect(f.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer deepseek-key' })
  })

  it('anthropic sends system separately and parses text_delta events', async () => {
    const f = vi.fn().mockResolvedValue(streamResponse([
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ]))
    vi.stubGlobal('fetch', f)
    const { chat } = await import('./agent')
    const out = await chat(
      [{ role: 'system', content: 'be concise' }, { role: 'user', content: 'hi' }],
      config({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'token', anthropicAuthMode: 'auth-token' }),
    )
    expect(out).toBe('Claude')
    expect(f.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    const init = f.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token')
    const body = JSON.parse(String(init.body)) as { system: string; messages: Array<{ role: string }> }
    expect(body.system).toBe('be concise')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('anthropic surfaces stream error events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'event: error\n',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ])))
    const { chat } = await import('./agent')
    await expect(chat(
      [{ role: 'user', content: 'hi' }],
      config({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
    )).rejects.toThrow('Overloaded')
  })

  it.each([
    {
      provider: 'ollama' as const,
      chunks: ['{"message":{"content":"```sh\\nwhoami\\n```"},"done":false}\n'],
    },
    {
      provider: 'openai' as const,
      chunks: ['data: {"choices":[{"delta":{"content":"```sh\\nwhoami\\n```"}}]}\n\n'],
    },
    {
      provider: 'anthropic' as const,
      chunks: ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"```sh\\nwhoami\\n```"}}\n\n'],
    },
  ])('rejects a truncated $provider stream even when it already contains a complete shell fence', async ({ provider, chunks }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(chunks)))
    const { chat } = await import('./agent')
    await expect(chat(
      [{ role: 'user', content: 'hi' }],
      config({ provider, baseUrl: provider === 'ollama' ? 'http://h' : `https://${provider}.example` }),
    )).rejects.toThrow('completion marker')
  })
})
