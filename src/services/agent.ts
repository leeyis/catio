import { MODEL_PROVIDER_PRESETS, type AgentConfig } from '../state/agentConfig'
import { apiHeaders, providerApiBase, resolveFetch, trimSlash } from './models'

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatOptions { onToken?: (t: string) => void; signal?: AbortSignal }

// ---- Typed shapes for streaming responses (no `any`) ----

interface OllamaStreamLine {
  message?: { content?: string }
  done?: boolean
}

interface OpenAIStreamLine {
  choices?: Array<{ delta?: { content?: string } }>
}

interface AnthropicStreamLine {
  type?: string
  delta?: { type?: string; text?: string }
  error?: { message?: string }
}

function isOllamaStreamLine(v: unknown): v is OllamaStreamLine {
  return typeof v === 'object' && v !== null
}

function isOpenAIStreamLine(v: unknown): v is OpenAIStreamLine {
  return typeof v === 'object' && v !== null
}

function isAnthropicStreamLine(v: unknown): v is AnthropicStreamLine {
  return typeof v === 'object' && v !== null
}

/**
 * Read the full response body as a string, line-by-line, calling `processLine`
 * for each complete line. Handles chunks that arrive mid-line by buffering.
 */
async function readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  processLine: (line: string) => boolean, // return true to stop early
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) break

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process all complete lines in the buffer
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        const shouldStop = processLine(line)
        if (shouldStop) return
      }
    }

    // Flush any remaining partial content (no trailing newline)
    if (buffer.length > 0) {
      processLine(buffer)
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Streaming chat. Calls onToken for each delta; resolves to the full accumulated text.
 * Throws on HTTP errors or missing response body.
 */
export async function chat(
  messages: ChatMsg[],
  cfg: AgentConfig,
  opts: ChatOptions = {},
): Promise<string> {
  const fetcher = await resolveFetch()
  const { onToken, signal } = opts
  let accumulated = ''
  let completed = false
  const protocol = MODEL_PROVIDER_PRESETS[cfg.provider].protocol

  let url: string
  let headers: Record<string, string>
  let body: string

  if (protocol === 'ollama') {
    url = `${trimSlash(cfg.baseUrl)}/api/chat`
    headers = { 'Content-Type': 'application/json' }
    body = JSON.stringify({ model: cfg.model, messages, stream: true })
  } else if (protocol === 'anthropic') {
    url = `${providerApiBase(cfg)}/messages`
    headers = apiHeaders(cfg, true)
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
    body = JSON.stringify({
      model: cfg.model,
      messages: messages.filter(message => message.role !== 'system'),
      max_tokens: 4096,
      stream: true,
      ...(system ? { system } : {}),
    })
  } else {
    url = `${providerApiBase(cfg)}/chat/completions`
    headers = apiHeaders(cfg, true)
    body = JSON.stringify({ model: cfg.model, messages, stream: true })
  }

  const resp = await fetcher(url, { method: 'POST', headers, body, signal })

  if (!resp.ok) {
    let snippet = ''
    try {
      const text = await resp.text()
      snippet = text.slice(0, 200)
    } catch { /* best-effort */ }
    throw new Error(`HTTP ${resp.status}${snippet ? ': ' + snippet : ''}`)
  }

  if (!resp.body) {
    throw new Error('Response body is null; streaming not supported in this environment')
  }

  if (protocol === 'ollama') {
    // Newline-delimited JSON (NDJSON): each line is a JSON object
    await readLines(resp.body, signal, (line) => {
      const trimmed = line.trim()
      if (!trimmed) return false

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return false // skip malformed lines
      }

      if (!isOllamaStreamLine(parsed)) return false

      const content = parsed.message?.content
      if (content) {
        accumulated += content
        onToken?.(content)
      }

      // Stop when done flag is set
      if (parsed.done === true) completed = true
      return completed
    })
  } else if (protocol === 'anthropic') {
    await readLines(resp.body, signal, (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return false
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed.slice('data:'.length).trim())
      } catch {
        return false
      }
      if (!isAnthropicStreamLine(parsed)) return false
      if (parsed.type === 'error') {
        throw new Error(parsed.error?.message || 'Anthropic stream error')
      }
      const content = parsed.delta?.type === 'text_delta' ? parsed.delta.text : undefined
      if (content) {
        accumulated += content
        onToken?.(content)
      }
      if (parsed.type === 'message_stop') completed = true
      return completed
    })
  } else {
    // Server-Sent Events (SSE): lines prefixed with "data: "
    await readLines(resp.body, signal, (line) => {
      const trimmed = line.trim()
      if (!trimmed) return false // skip blank lines (SSE uses blank lines as separators)

      if (!trimmed.startsWith('data:')) return false

      const payload = trimmed.slice('data:'.length).trim()
      if (payload === '[DONE]') {
        completed = true
        return true
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        return false // skip malformed lines
      }

      if (!isOpenAIStreamLine(parsed)) return false

      const content = parsed.choices?.[0]?.delta?.content
      if (content) {
        accumulated += content
        onToken?.(content)
      }

      return false
    })
  }

  if (!completed && !signal?.aborted) {
    throw new Error('Model stream ended before its completion marker')
  }

  return accumulated
}
