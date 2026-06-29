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
    const data: unknown = text ? JSON.parse(text) : null
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
