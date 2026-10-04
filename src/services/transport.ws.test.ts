import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A minimal fake WebSocket so we can drive open/message/close deterministically.
class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  sent: string[] = []
  constructor(public url: string) { FakeWS.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
  fireOpen() { this.readyState = 1; this.onopen?.() }
  fireMsg(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }) }
}

const tick = () => new Promise(r => setTimeout(r, 0))
const lastWs = () => FakeWS.instances[FakeWS.instances.length - 1]
type Frame = { type: string; topic?: string; cmd?: string; id?: unknown }
const frames = (ws: FakeWS): Frame[] => ws.sent.map(s => JSON.parse(s) as Frame)
function setServer(on: boolean) {
  const w = window as unknown as Record<string, unknown>
  if (on) w.__CATIO_SERVER__ = true
  else delete w.__CATIO_SERVER__
}

describe('transport WebSocket client', () => {
  beforeEach(() => {
    vi.resetModules() // fresh module → fresh socket singleton per test
    FakeWS.instances = []
    setServer(true)
    vi.stubGlobal('WebSocket', FakeWS)
  })
  afterEach(() => { setServer(false); vi.unstubAllGlobals() })

  it('subscribe sends sub, routes events, and unsubscribe sends unsub', async () => {
    const { subscribe } = await import('./transport')
    const got: unknown[] = []
    const p = subscribe('term://c1', e => got.push(e))
    const ws = lastWs()
    ws.fireOpen()
    const unsub = await p

    expect(frames(ws).some(m => m.type === 'sub' && m.topic === 'term://c1')).toBe(true)

    ws.fireMsg({ type: 'event', topic: 'term://c1', payload: { bytesBase64: 'aGk=' } })
    expect(got).toEqual([{ bytesBase64: 'aGk=' }])

    unsub()
    expect(frames(ws).some(m => m.type === 'unsub' && m.topic === 'term://c1')).toBe(true)
  })

  it('ordered consumers wait for a server subscription receipt, not merely socket open', async () => {
    const { subscribe, ensureSubscription } = await import('./transport')
    const handler = vi.fn()
    const unsub = await subscribe('agent://events', handler)
    const done = vi.fn()
    const ready = ensureSubscription('agent://events').then(done)
    const ws = lastWs()
    expect(done).not.toHaveBeenCalled()
    ws.fireOpen(); await tick()
    const request = frames(ws).find(m => m.type === 'sub' && m.id)!
    expect(request).toBeTruthy()
    expect(done).not.toHaveBeenCalled()
    ws.fireMsg({ type: 'reply', id: request.id, ok: true, result: { topic: 'agent://events' } })
    await ready
    expect(done).toHaveBeenCalledOnce()
    ws.fireMsg({ type: 'event', topic: 'agent://events', payload: { sequence: 1 } })
    expect(handler).toHaveBeenCalledWith({ sequence: 1 })
    unsub(); ws.close()
  })

  it('denied subscriptions reject and a later attempt needs its own receipt', async () => {
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const ws = lastWs(); ws.fireOpen()
    const ready = ensureSubscription('agent://events'); const rejected = expect(ready).rejects.toThrow('denied')
    await tick()
    const first = frames(ws).find(m => m.type === 'sub' && m.id)!
    ws.fireMsg({ type: 'reply', id: first.id, ok: false, error: 'denied' }); await rejected
    const done = vi.fn(), retry = ensureSubscription('agent://events').then(done)
    await tick()
    const second = frames(ws).filter(m => m.type === 'sub' && m.id).at(-1)!
    expect(second.id).not.toBe(first.id)
    ws.fireMsg({ type: 'reply', id: first.id, ok: true }); await tick()
    expect(done).not.toHaveBeenCalled()
    ws.fireMsg({ type: 'reply', id: second.id, ok: true }); await retry
    unsub(); ws.close()
  })

  it('reconnect requires a new acknowledged registration before the next HTTP turn', async () => {
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const ws = lastWs(); ws.fireOpen()
    const first = ensureSubscription('agent://events'); await tick()
    ws.fireMsg({ type: 'reply', id: frames(ws).find(m => m.type === 'sub' && m.id)!.id, ok: true }); await first
    ws.close()
    const done = vi.fn(), next = ensureSubscription('agent://events').then(done)
    const ws2 = lastWs(); expect(ws2).not.toBe(ws); ws2.fireOpen(); await tick()
    expect(done).not.toHaveBeenCalled()
    ws2.fireMsg({ type: 'reply', id: frames(ws2).find(m => m.type === 'sub' && m.id)!.id, ok: true }); await next
    unsub(); ws2.close()
  })

  it('does not report readiness without a registered consumer', async () => {
    const { ensureSubscription } = await import('./transport')
    await expect(ensureSubscription('agent://events')).rejects.toThrow(/subscriber/i)
    expect(FakeWS.instances).toHaveLength(0)
  })

  it('bounds connection readiness when WebSocket never opens', async () => {
    vi.useFakeTimers()
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const ready = ensureSubscription('agent://events', 25)
    const rejected = expect(ready).rejects.toMatchObject({ code: 'eventSubscriptionUnavailable' })
    await vi.advanceTimersByTimeAsync(26); await rejected
    unsub(); lastWs().close(); vi.useRealTimers()
  })

  it('rejects an acknowledgement timeout without letting a late receipt satisfy a new request', async () => {
    vi.useFakeTimers()
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const ws = lastWs(); ws.fireOpen()
    const ready = ensureSubscription('agent://events', 25)
    const rejected = expect(ready).rejects.toMatchObject({ code: 'eventSubscriptionUnavailable' })
    await vi.advanceTimersByTimeAsync(26); await rejected
    const first = frames(ws).find(f => f.id)!
    const done = vi.fn(), next = ensureSubscription('agent://events', 25).then(done)
    await vi.advanceTimersByTimeAsync(0)
    ws.fireMsg({ type: 'reply', id: first.id, ok: true }); await vi.advanceTimersByTimeAsync(0)
    expect(done).not.toHaveBeenCalled()
    ws.fireMsg({ type: 'reply', id: frames(ws).filter(f => f.id).at(-1)!.id, ok: true }); await next
    unsub(); ws.close(); vi.useRealTimers()
  })

  it('drops orphaned Agent messages instead of replaying a prior owner into a new consumer', async () => {
    const { subscribe } = await import('./transport')
    const warm = await subscribe('warm', () => {})
    const ws = lastWs(); ws.fireOpen()
    ws.fireMsg({ type: 'event', topic: 'agent://events', payload: { ownerId: 'old-owner' } })
    const handler = vi.fn(), unsub = await subscribe('agent://events', handler)
    expect(handler).not.toHaveBeenCalled()
    unsub(); warm(); ws.close()
  })

  it('closes an expired-auth socket so retry can authenticate with the current cookie', async () => {
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const ws = lastWs(); ws.fireOpen()
    const ready = ensureSubscription('agent://events'), rejected = expect(ready).rejects.toMatchObject({ code: 'eventSubscriptionUnavailable' })
    await tick()
    ws.fireMsg({ type: 'reply', id: frames(ws).find(f => f.id)!.id, ok: false, error: 'Subscription session expired' })
    await rejected
    expect(ws.readyState).toBe(3)
    unsub()
  })

  it('wraps a WebSocket DOMException without trying to overwrite its readonly code property', async () => {
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const ws = lastWs(); ws.fireOpen(); await tick()
    vi.spyOn(ws, 'send').mockImplementationOnce(() => { throw new DOMException('closed', 'InvalidStateError') })
    await expect(ensureSubscription('agent://events')).rejects.toMatchObject({ code: 'eventSubscriptionUnavailable' })
    unsub(); ws.close()
  })

  it('a late close from a superseded socket cannot reject the new socket receipt', async () => {
    const { subscribe, ensureSubscription } = await import('./transport')
    const unsub = await subscribe('agent://events', () => {})
    const old = lastWs(); old.fireOpen(); await tick()
    old.readyState = 2 // closing, but onclose has not fired yet
    const next = ensureSubscription('agent://events')
    const ws = lastWs(); expect(ws).not.toBe(old); ws.fireOpen(); await tick()
    const request = frames(ws).find(frame => frame.id)!
    old.close()
    ws.fireMsg({ type: 'reply', id: request.id, ok: true })
    await expect(next).resolves.toBeUndefined()
    const again = ensureSubscription('agent://events'); await tick()
    expect(lastWs()).toBe(ws)
    ws.fireMsg({ type: 'reply', id: frames(ws).filter(frame => frame.id).at(-1)!.id, ok: true })
    await again
    unsub(); ws.close()
  })

  it('wsCmd sends a cmd and resolves with the matching reply result', async () => {
    const { wsCmd } = await import('./transport')
    const pr = wsCmd<{ chanId: string }>('term_open', { sessionId: 's1', cols: 80, rows: 24 })
    const ws = lastWs()
    ws.fireOpen()
    await tick()
    const cmd = frames(ws).find(m => m.type === 'cmd')!
    expect(cmd.cmd).toBe('term_open')
    ws.fireMsg({ type: 'reply', id: cmd.id, ok: true, result: { chanId: 'chan-9' } })
    expect(await pr).toEqual({ chanId: 'chan-9' })
  })

  it('buffers an event that arrives before its handler, then delivers it on subscribe', async () => {
    const { subscribe } = await import('./transport')
    // Open the socket (warm-up subscribe) so onmessage is wired up.
    const p0 = subscribe('warmup', () => {})
    const ws = lastWs()
    ws.fireOpen()
    await p0
    // An event arrives for a topic with NO handler yet (the VNC vnc-init race) → buffered.
    ws.fireMsg({ type: 'event', topic: 'vnc-init://v1', payload: { width: 800, height: 600 } })
    // Subscribing now must immediately replay the buffered event (no lost init frame).
    const got: unknown[] = []
    await subscribe('vnc-init://v1', e => got.push(e))
    expect(got).toEqual([{ width: 800, height: 600 }])
  })

  it('wsNotify sends a cmd with no id (fire-and-forget)', async () => {
    const { wsNotify } = await import('./transport')
    wsNotify('vnc_pointer', { sessionId: 's', mask: 1, x: 10, y: 20 })
    const ws = lastWs()
    ws.fireOpen()
    await tick()
    const cmd = frames(ws).find(m => m.cmd === 'vnc_pointer')
    expect(cmd).toBeTruthy()
    expect(cmd?.id).toBeUndefined()
  })

  it('wsCmd rejects on an error reply', async () => {
    const { wsCmd } = await import('./transport')
    const pr = wsCmd('term_open', { sessionId: 'nope' })
    const ws = lastWs()
    ws.fireOpen()
    await tick()
    const cmd = frames(ws).find(m => m.type === 'cmd')!
    ws.fireMsg({ type: 'reply', id: cmd.id, ok: false, error: 'session not found' })
    await expect(pr).rejects.toThrow('session not found')
  })
})
