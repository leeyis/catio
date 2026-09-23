// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const bootstrap = readFileSync('src-tauri/src/diagnostics-bootstrap.js', 'utf8')
function harness(invoke = vi.fn().mockResolvedValue(undefined)) {
  const listeners: Record<string, (e: Record<string, unknown>) => void> = {}
  const window = {
    __TAURI_INTERNALS__: { invoke },
    addEventListener: vi.fn((name: string, handler: typeof listeners[string]) => { listeners[name] = handler }),
    __CATIO_DIAGNOSTICS__: undefined as undefined | { report: (event: string, error?: unknown, operation?: string) => void },
  }
  const context = { window, setTimeout, Date }
  runInNewContext(bootstrap, context)
  return { window, listeners, invoke, context }
}
afterEach(() => vi.useRealTimers())

describe('native-injected runtime diagnostics', () => {
  it('captures errors before React starts and strips all error payloads/URL secrets', async () => {
    const h = harness()
    h.listeners.error({
      target: h.window,
      error: { name: 'ReferenceError', message: 'structuredClone is not defined password=hunter2',
        stack: 'ReferenceError: token=private\n at new Dx (http://admin:secret@internal/assets/index-abc.js:188:42)\n at C:\\private\\key.pem' },
    })
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
    expect(h.invoke.mock.calls[1][1].event).toEqual({
      event: 'javascript-error', errorType: 'ReferenceError', code: 'missing-structuredClone', frames: ['assets/index-abc.js:188:42'],
    })
    const logged = JSON.stringify(h.invoke.mock.calls)
    for (const secret of ['hunter2', 'private', 'secret', 'internal', 'admin', 'key.pem']) expect(logged).not.toContain(secret)
  })

  it('does not stringify arbitrary rejected objects or failed resource URLs', async () => {
    const h = harness()
    h.listeners.unhandledrejection({ reason: { password: 'sensitive', key: '-----BEGIN PRIVATE KEY-----', toString() { throw new Error('do not inspect') } } })
    h.listeners.error({ target: { src: 'https://host/?token=sensitive' } })
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(3))
    expect(h.invoke.mock.calls[1][1].event.errorType).toBe('Unknown')
    expect(h.invoke.mock.calls[2][1].event.event).toBe('resource-error')
    expect(JSON.stringify(h.invoke.mock.calls)).not.toMatch(/sensitive|PRIVATE KEY|https/)
  })

  it('retries a failed write without disabling later diagnostics or recursive errors', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockRejectedValueOnce(new Error('disk temporarily unavailable')).mockResolvedValue(undefined)
    const h = harness(invoke)
    h.window.__CATIO_DIAGNOSTICS__!.report('frontend-ready')
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke.mock.calls[2][1].event.event).toBe('frontend-ready')
  })

  it('limits error storms and installs only one set of listeners', async () => {
    const h = harness()
    runInNewContext(bootstrap, h.context)
    expect(h.window.addEventListener).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 1000; i++) h.listeners.error({ target: h.window })
    await vi.waitFor(() => expect(h.invoke.mock.calls.length).toBeGreaterThan(1))
    expect(h.invoke.mock.calls.length).toBeLessThanOrEqual(40)
  })
})
