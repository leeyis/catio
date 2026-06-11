/**
 * Pure cursor/document stats for the SQL editor status bar. Kept free of
 * CodeMirror types so it can be unit-tested directly; the component feeds it
 * the doc text and caret offset from the EditorState.
 *
 * Lines: an empty doc is 1 line; a trailing newline opens a new (empty) line —
 * matching CodeMirror's `doc.lines`. Line/col are 1-based.
 */
export interface EditorStats {
  lines: number
  chars: number
  line: number
  col: number
}

export function editorStats(text: string, head: number): EditorStats {
  const chars = text.length
  const pos = Math.max(0, Math.min(head, chars))
  const lines = text === '' ? 1 : text.split('\n').length
  const before = text.slice(0, pos)
  const nlIdx = before.lastIndexOf('\n')
  const line = before === '' ? 1 : before.split('\n').length
  const col = pos - (nlIdx + 1) + 1
  return { lines, chars, line, col }
}
