// App-wide appearance & agent preferences with localStorage persistence and a
// tiny subscribable store so every consumer (body font, terminals, settings UI,
// the agent send-path) re-renders live when a value changes — unlike the
// per-component useState stores, a change in Settings reaches App immediately.

import { useSyncExternalStore } from 'react'

export type UiFontKey = 'inter' | 'system'
export type MonoFontKey = 'geist' | 'system'
export type Density = 'comfortable' | 'compact'

export interface Prefs {
  uiFont: UiFontKey
  monoFont: MonoFontKey
  /** xterm render size in px (also used for the terminal surface). */
  termFontPx: number
  density: Density
  /** Catio Agent: feed the active terminal's recent output as context. */
  termBufferEnabled: boolean
  /** How many trailing terminal lines to include when termBufferEnabled. */
  termBufferLines: number
  /** MCP server IP whitelist (CIDR/IP entries); empty means allow all. */
  mcpWhitelist: string[]
  /** Stream MCP access events to the live-log panel over `mcp://log`. */
  mcpLiveLog: boolean
}

interface FontOption<K> { key: K; label: string; stack: string }

export const UI_FONTS: FontOption<UiFontKey>[] = [
  { key: 'inter', label: 'Inter', stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { key: 'system', label: '系统默认', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" },
]

export const MONO_FONTS: FontOption<MonoFontKey>[] = [
  { key: 'geist', label: 'Geist Mono', stack: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace" },
  { key: 'system', label: '系统等宽', stack: "ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, Menlo, monospace" },
]

/** Selectable terminal font sizes (px). */
export const TERM_FONT_SIZES = [11, 12, 12.5, 13, 14, 16] as const

/** Selectable line counts for the agent terminal-buffer context. */
export const TERM_BUFFER_LINE_OPTIONS = [20, 50, 100, 200] as const

export const uiFontStack = (k: UiFontKey): string => (UI_FONTS.find(f => f.key === k) ?? UI_FONTS[0]).stack
export const monoFontStack = (k: MonoFontKey): string => (MONO_FONTS.find(f => f.key === k) ?? MONO_FONTS[0]).stack

export const DEFAULT_PREFS: Prefs = {
  uiFont: 'inter',
  monoFont: 'geist',
  termFontPx: 12.5,
  density: 'comfortable',
  termBufferEnabled: true,
  termBufferLines: 50,
  mcpWhitelist: [],
  mcpLiveLog: false,
}

const STORAGE_KEY = 'catio-prefs'

function read(): Prefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

let state: Prefs = read()
const listeners = new Set<() => void>()

export function getPrefs(): Prefs {
  return state
}

export function setPrefs(patch: Partial<Prefs>): void {
  state = { ...state, ...patch }
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* ignore quota */ }
  }
  listeners.forEach(l => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function usePrefs(): { prefs: Prefs; update: (patch: Partial<Prefs>) => void } {
  const prefs = useSyncExternalStore(subscribe, getPrefs, getPrefs)
  return { prefs, update: setPrefs }
}
