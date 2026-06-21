// Per-connection "hidden schemas" filter for the SchemaBrowser, persisted in
// localStorage so a user's choice to hide databases/schemas they don't care about
// survives reconnects and restarts. Keyed by the stable connection profile id;
// absence means "nothing hidden" (default: show ALL schemas).

const STORAGE_KEY = 'catio-hidden-schemas'
type Store = Record<string, string[]>

function read(): Store {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Store
  } catch {
    return {}
  }
}

/** Hidden schema names for a connection (empty array = show all). */
export function readHiddenSchemas(connKey: string): string[] {
  return read()[connKey] ?? []
}

/** Persist the hidden-schema set for a connection. An empty set clears the entry. */
export function writeHiddenSchemas(connKey: string, hidden: string[]): void {
  if (typeof localStorage === 'undefined') return
  const store = read()
  if (hidden.length) store[connKey] = hidden
  else delete store[connKey]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* ignore quota */
  }
}
