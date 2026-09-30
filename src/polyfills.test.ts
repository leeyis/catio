import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { AIPanel } from './components/panels/AIPanel'
import { LanguageProvider } from './state/LanguageContext'
import { getAgentConfig, setAgentConfig } from './state/agentConfig'

// Server rendering exercises the real Agent/Markdown path without jsdom's own
// use of modern Object APIs masking the application's failure.
function renderAgent(content: string, busy = false): string {
  return renderToStaticMarkup(createElement(LanguageProvider, null,
    createElement(AIPanel, {
      mode: 'shell',
      conn: { id: 'compat-host', group: '', kind: 'host', name: 'Compatibility test', sub: '', icon: 'server', status: 'up', proto: 'ssh' },
      attachment: null, onClose: () => {}, onClearAttachment: () => {}, busy,
      conversation: {
        id: 'compat-conversation', hostKey: 'compat-host', title: '', createdAt: 1, updatedAt: 1,
        messages: [{ role: 'assistant', content }],
      },
    }),
  ))
}

describe('browser without structuredClone and Object.hasOwn (Edge 90)', () => {
  let Terminal: typeof XtermTerminal
  const nativeHasOwn = Object.getOwnPropertyDescriptor(Object, 'hasOwn')
  const initialAgentConfig = getAgentConfig()
  beforeAll(async () => {
    localStorage.clear()
    setAgentConfig({ model: 'compatibility-test-model' })
    // jsdom has no canvas. xterm handles a null context during module loading;
    // rendering is outside this test, but the terminal core stays unmocked.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    try {
      ;({ Terminal } = await import('@xterm/xterm'))
    } finally {
      getContext.mockRestore()
    }
    vi.stubGlobal('structuredClone', undefined)
    // Exercise the real dependency: component tests mock xterm and cannot catch
    // this constructor failure. Keep this assertion before loading the shim.
    expect(() => new Terminal()).toThrow(/structuredClone/)
    Object.defineProperty(Object, 'hasOwn', { value: undefined, configurable: true, writable: true })
    expect(() => renderAgent('Agent reply')).toThrow(/Object\.hasOwn/)
    await import('./polyfills')
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    if (nativeHasOwn) Object.defineProperty(Object, 'hasOwn', nativeHasOwn)
    else Reflect.deleteProperty(Object, 'hasOwn')
    setAgentConfig(initialAgentConfig)
    localStorage.clear()
  })

  it.each([
    ['<think>Inspect **status**', 'status'],
    ['<think>Inspect **status**</think>\n\n## Result\n\nReceiving reply', 'Receiving reply'],
    ['## Result\n\nReceiving **reply**', 'reply'],
  ])('renders streaming Agent content: %s', (content, expected) => {
    const html = renderAgent(content, true)
    expect(html).toContain(expected)
    expect(html).not.toContain('&lt;think&gt;')
    expect(html).toContain('<strong')
  })

  it('renders Agent answers with GFM tables, code, entities and sanitized links', () => {
    const html = renderAgent([
      '<think>Inspect **status**.</think>',
      '', '## Result', '', '**Healthy** &copy;', '',
      '| Service | State |', '| --- | --- |', '| SSH | Running |', '',
      '[Documentation](https://example.test/help)',
      '[Blocked](javascript:alert%281%29)', '',
      '```sh', "printf 'ready'", '```',
    ].join('\n'))
    expect(html).toContain('<h2')
    expect(html).toContain('Healthy')
    expect(html).toContain('©')
    expect(html).toContain('<table')
    expect(html).toContain('Running')
    expect(html).toContain('printf')
    expect(html).toContain('href="https://example.test/help"')
    expect(html).not.toContain('href="javascript:')
  })

  it('creates, writes to, and resets a real xterm terminal', async () => {
    const term = new Terminal({ allowProposedApi: true })
    try {
      await new Promise<void>(resolve => term.write('\x1b[?1hhello', resolve))
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('hello')
      expect(term.modes.applicationCursorKeysMode).toBe(true)
      term.reset()
      expect(term.modes.applicationCursorKeysMode).toBe(false)
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('')
    } finally {
      term.dispose()
    }
  })

  it('preserves undefined properties and nested/cyclic values without sharing state', () => {
    const original = { cursorStyle: undefined, nested: { wraparound: true } }
    const clone = structuredClone(original)
    expect(clone).toEqual(original)
    expect(Object.prototype.hasOwnProperty.call(clone, 'cursorStyle')).toBe(true)
    clone.nested.wraparound = false
    expect(original.nested.wraparound).toBe(true)

    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const copiedCycle = structuredClone(cyclic)
    expect(copiedCycle).not.toBe(cyclic)
    expect(copiedCycle.self).toBe(copiedCycle)
  })
})
