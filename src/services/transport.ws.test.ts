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
