//! Single transport abstraction for the three runtime modes catio ships in:
//!
//!   | mode                  | isTauri | __CATIO_SERVER__ | path                       |
//!   |-----------------------|---------|------------------|----------------------------|
//!   | desktop (Tauri)       | true    | —                | invoke(cmd, args)          |
//!   | browser (server head) | false   | true             | POST /api/invoke {cmd,args} |
//!   | vitest / vite dev     | false   | false            | caller falls back to mock  |
//!
//! Services collapse their per-file `tauriInvoke` onto `rpc()` and their event
//! `listen()` onto `subscribe()`, then keep ONE mock guard: `if (!isTauri() && !isServer())
//! return mock`. Tests set neither flag, so the mock path is unchanged. The HTTP wire format
//! is identical to Tauri's `invoke(cmd, args)` — same `{cmd,args}`, same camelCase — so each
//! command migrates independently and the multi-user evolution needs no UI change.

/** Desktop runtime — the Tauri webview injects these globals. */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

/** Server runtime — `catio-server` injects `window.__CATIO_SERVER__=true` into index.html. */
export const isServer = (): boolean =>
  typeof window !== 'undefined' && '__CATIO_SERVER__' in window &&
  (window as unknown as Record<string, unknown>).__CATIO_SERVER__ === true

/**
 * Invoke a backend command. Mirrors Tauri's `invoke(cmd, args)` exactly; under server mode
 * it POSTs the same `{cmd,args}` to `/api/invoke`. The cookie travels with the request
 * (`credentials: 'include'`) so M2 session auth works without touching call sites.
 *
 * On a non-2xx HTTP response the server returns `{ error: string }`; `rpc` rethrows that
 * message as an `Error`, so existing `dbErrMsg(e)` / try-catch paths keep working.
 *
 * Outside both runtimes `rpc` throws — callers are expected to short-circuit to their mock
 * BEFORE calling `rpc` (the `if (!isTauri() && !isServer()) return mock` guard).
 */
export async function rpc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  if (isServer()) {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ cmd, args: args ?? {} }),
    })
    const text = await res.text()
    // Parse defensively: a reverse proxy can return HTML/plaintext (502/504/404) that is not
    // JSON. Surface the HTTP status instead of a misleading "Unexpected token <" parse error.
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      throw new Error(res.ok ? `Invalid JSON response (HTTP ${res.status})` : `HTTP ${res.status}`)
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && 'error' in data)
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`
      throw new Error(msg)
    }
    return data as T
  }
  throw new Error(`rpc(${cmd}) called with no active transport (caller should take the mock path)`)
}

// ─── Streaming channel (M3): one shared WebSocket in server mode ──────────────────────────────
//
// `subscribe(topic, handler)` collapses Tauri `listen` and the web WS onto one call; `wsCmd`
// sends a streaming command (term_open/write/resize/close) and awaits its reply. The socket is
// a lazily-opened singleton with auto-reconnect, heartbeat, and topic re-subscription, so a
// dropped connection transparently restores the terminal stream.

type Handler = (payload: unknown) => void

const topicHandlers = new Map<string, Set<Handler>>()
// Events that arrive for a topic before its handler is registered (e.g. the VNC `vnc-init` that
// the server emits the instant it connects, before the client's `subscribe` runs). Buffered
// briefly and flushed when a handler subscribes, so no early frame is lost. Bounded by the TTL.
const earlyEvents = new Map<string, { payload: unknown; t: number }[]>()
const EARLY_EVENT_TTL_MS = 3000
const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let sock: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null
let cmdSeq = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let missedPongs = 0
/** Reply timeout — a never-answered command must not hang the UI or leak a pending entry forever. */
const WS_CMD_TIMEOUT_MS = 15000

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

function ensureSocket(): Promise<WebSocket> {
  if (sock && sock.readyState === WebSocket.OPEN) return Promise.resolve(sock)
  if (connecting) return connecting
  connecting = new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(wsUrl())
    s.onopen = () => {
      sock = s
      connecting = null
      missedPongs = 0
      // Restore every active subscription after a (re)connect so streams resume.
      for (const topic of topicHandlers.keys()) s.send(JSON.stringify({ type: 'sub', topic }))
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          if (sock?.readyState !== WebSocket.OPEN) return
          // Two missed pongs ⇒ half-open connection ⇒ force-close so onclose reconnects.
          if (missedPongs >= 2) { sock.close(); return }
          missedPongs++
          sock.send(JSON.stringify({ type: 'ping' }))
        }, 30000)
      }
      resolve(s)
    }
    s.onerror = () => { if (connecting) { connecting = null; reject(new Error('WebSocket connection failed')) } }
    s.onclose = () => {
      sock = null
      connecting = null
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      // Fail any in-flight commands; subscriptions stay registered and re-sent on next connect.
      for (const [, p] of pendingReplies) p.reject(new Error('WebSocket closed'))
      pendingReplies.clear()
      // Proactively reconnect when subscriptions are live: a receive-only terminal would not
      // otherwise call ensureSocket again. Small delay avoids a tight reconnect storm.
      if (topicHandlers.size > 0) {
        setTimeout(() => { if (!sock && topicHandlers.size > 0) ensureSocket().catch(() => { /* retry on next close */ }) }, 1000)
      }
    }
    s.onmessage = ev => {
      let env: { type?: string; topic?: string; payload?: unknown; id?: unknown; ok?: boolean; result?: unknown; error?: string }
      try { env = JSON.parse(ev.data as string) } catch { return }
      if (env.type === 'event' && typeof env.topic === 'string') {
        const hs = topicHandlers.get(env.topic)
        if (hs && hs.size) {
          for (const h of hs) h(env.payload)
        } else {
          // No handler yet → buffer (pruning expired) so a just-about-to-subscribe pane gets it.
          const now = Date.now()
          const arr = (earlyEvents.get(env.topic) ?? []).filter(e => now - e.t < EARLY_EVENT_TTL_MS)
          arr.push({ payload: env.payload, t: now })
          earlyEvents.set(env.topic, arr)
        }
      } else if (env.type === 'reply') {
        const p = pendingReplies.get(String(env.id))
        if (p) {
          pendingReplies.delete(String(env.id))
          if (env.ok) p.resolve(env.result)
          else p.reject(new Error(env.error || 'command failed'))
        }
      } else if (env.type === 'pong') {
        missedPongs = 0
      }
    }
  })
  return connecting
}

/**
 * Subscribe to a backend event topic. Tauri → `listen`; server → WS subscription; dev/test → a
 * no-op (the mock path doesn't stream). Returns an unsubscribe function.
 *
 * The handler is registered synchronously (so a reconnect re-subscribes it); the immediate `sub`
 * send is best-effort — if the socket isn't up yet, `onopen` resubscribes every live topic.
 */
export async function subscribe(topic: string, handler: Handler): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen(topic, (e: { payload: unknown }) => handler(e.payload))
  }
  if (isServer()) {
    let set = topicHandlers.get(topic)
    if (!set) { set = new Set(); topicHandlers.set(topic, set) }
    set.add(handler)
    // Flush any events that arrived for this topic before the handler existed (the early-frame race).
    const buffered = earlyEvents.get(topic)
    if (buffered) {
      earlyEvents.delete(topic)
      const now = Date.now()
      for (const e of buffered) if (now - e.t < EARLY_EVENT_TTL_MS) handler(e.payload)
    }
    void ensureSocket().then(s => s.send(JSON.stringify({ type: 'sub', topic }))).catch(() => { /* resubscribed on reconnect */ })
    return () => {
      const cur = topicHandlers.get(topic)
      if (!cur) return
      cur.delete(handler)
      if (cur.size === 0) {
        topicHandlers.delete(topic)
        if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'unsub', topic }))
      }
    }
  }
  return () => { /* no-op outside Tauri/server */ }
}

/** Send a streaming command over the WS and await its reply (server mode only). Rejects on a
 *  reply timeout so a dropped/forgotten reply can't hang the caller or leak a pending entry.
 *  `timeoutMs` overrides the default for slow commands (e.g. vnc_connect's TCP+handshake). */
export async function wsCmd<T>(cmd: string, args: Record<string, unknown>, timeoutMs = WS_CMD_TIMEOUT_MS): Promise<T> {
  const s = await ensureSocket()
  const id = `c${++cmdSeq}`
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingReplies.delete(id)) reject(new Error(`命令超时: ${cmd}`))
    }, timeoutMs)
    pendingReplies.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v as T) },
      reject: e => { clearTimeout(timer); reject(e) },
    })
    try {
      s.send(JSON.stringify({ type: 'cmd', id, cmd, args }))
    } catch (e) {
      clearTimeout(timer)
      pendingReplies.delete(id)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Fire-and-forget streaming command (no reply awaited) for high-frequency input like VNC
 *  pointer/key — sending without an `id` tells the server not to bother replying, so there's no
 *  per-event round-trip, pending entry, or timeout. Best-effort if the socket isn't up yet. */
export function wsNotify(cmd: string, args: Record<string, unknown>): void {
  void ensureSocket().then(s => s.send(JSON.stringify({ type: 'cmd', cmd, args }))).catch(() => { /* dropped if offline */ })
}
