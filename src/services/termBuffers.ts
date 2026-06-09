// Registry of live terminal buffer readers, keyed by sessionId. TerminalPane
// registers a getter for each live session; App reads the trailing N lines to
// feed the Catio Agent as context (gated by the prefs.termBufferEnabled toggle).
// Keeping this out of React state avoids re-rendering on every keystroke.

const readers = new Map<string, () => string>()

export function registerTermBuffer(sessionId: string, read: () => string): void {
  readers.set(sessionId, read)
}

export function unregisterTermBuffer(sessionId: string): void {
  readers.delete(sessionId)
}

/** Trailing `maxLines` lines of the session's terminal buffer, or '' if none. */
export function readTermBufferTail(sessionId: string, maxLines: number): string {
  const read = readers.get(sessionId)
  if (!read) return ''
  const text = read()
  if (!text) return ''
  const lines = text.split('\n')
  return lines.slice(-maxLines).join('\n').trim()
}
