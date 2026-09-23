import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Terminal as XtermTerminal } from '@xterm/xterm'

describe('browser without structuredClone (Edge 90)', () => {
  let Terminal: typeof XtermTerminal
  beforeAll(async () => {
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
    await import('./polyfills')
  })

  afterAll(() => vi.unstubAllGlobals())

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
