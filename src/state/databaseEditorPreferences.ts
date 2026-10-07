import { useSyncExternalStore } from 'react'

export interface DatabaseEditorPreferences {
  keywordCase: 'upper' | 'lower' | 'preserve'
  commaPosition: 'after' | 'before'
  tabWidth: 2 | 4 | 8
  completionOnTyping: boolean
  completionKey: 'Ctrl-Space' | 'Alt-Space'
  functionParameters: boolean
  signatureHelp: boolean
  referenceDiagnostics: boolean
  lineWrapping: boolean
  foldGutter: boolean
}
export const DEFAULT_DATABASE_EDITOR_PREFERENCES: Readonly<DatabaseEditorPreferences> = Object.freeze({
  keywordCase: 'upper', commaPosition: 'after', tabWidth: 2,
  completionOnTyping: true, completionKey: 'Ctrl-Space', functionParameters: true,
  signatureHelp: true, referenceDiagnostics: true, lineWrapping: false, foldGutter: true,
})
const KEY = 'catio:database:editor-preferences:v1'
const EVENT = 'catio:database:editor-preferences-changed'
let rawCache: string | null | undefined
let snapshot: DatabaseEditorPreferences = { ...DEFAULT_DATABASE_EDITOR_PREFERENCES }

/** Only non-sensitive presentation preferences. Never store SQL, metadata or connection IDs here. */
export function normalizeDatabaseEditorPreferences(value: unknown): DatabaseEditorPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const defaults = DEFAULT_DATABASE_EDITOR_PREFERENCES
  const bool = (key: keyof DatabaseEditorPreferences) => typeof input[key] === 'boolean' ? input[key] as boolean : defaults[key] as boolean
  return {
    keywordCase: input.keywordCase === 'lower' || input.keywordCase === 'preserve' ? input.keywordCase : 'upper',
    commaPosition: input.commaPosition === 'before' ? 'before' : 'after',
    tabWidth: input.tabWidth === 4 || input.tabWidth === 8 ? input.tabWidth : 2,
    completionKey: input.completionKey === 'Alt-Space' ? 'Alt-Space' : 'Ctrl-Space',
    completionOnTyping: bool('completionOnTyping'), functionParameters: bool('functionParameters'),
    signatureHelp: bool('signatureHelp'), referenceDiagnostics: bool('referenceDiagnostics'), lineWrapping: bool('lineWrapping'), foldGutter: bool('foldGutter'),
  }
}
export function readDatabaseEditorPreferences(): DatabaseEditorPreferences {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== rawCache) {
      rawCache = raw
      try { snapshot = normalizeDatabaseEditorPreferences(raw ? JSON.parse(raw) : null) }
      catch { snapshot = { ...DEFAULT_DATABASE_EDITOR_PREFERENCES } }
    }
  } catch { /* Retain the in-memory settings if storage is denied. */ }
  return snapshot
}
export function updateDatabaseEditorPreferences(patch: Partial<DatabaseEditorPreferences>): boolean {
  snapshot = normalizeDatabaseEditorPreferences({ ...readDatabaseEditorPreferences(), ...patch })
  let persisted = false
  try {
    const raw = JSON.stringify(snapshot)
    localStorage.setItem(KEY, raw)
    rawCache = raw
    persisted = true
  } catch { /* The caller reports memory-only application instead of claiming persistence. */ }
  window.dispatchEvent(new Event(EVENT))
  return persisted
}
function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener() }
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', onStorage) }
}
export function useDatabaseEditorPreferences() {
  return useSyncExternalStore(subscribe, readDatabaseEditorPreferences, () => DEFAULT_DATABASE_EDITOR_PREFERENCES)
}
