/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7 */

/* ---------- lightweight SQL highlighter ---------- */
const SQL_KW = /\b(select|from|where|and|or|in|not|order|by|group|limit|offset|join|left|right|inner|outer|on|as|insert|into|values|update|set|delete|create|table|interval|now|count|sum|avg|min|max|distinct|having|asc|desc|like|between|is|null|case|when|then|else|end)\b/gi
export function highlightSQL(code: string): string {
  // Tokenize in one pass so inserted var(--…) styles can't be re-matched.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const wrap = (s: string, color: string, bold?: boolean) => `<span style="color:${color}${bold ? ';font-weight:600' : ''}">${esc(s)}</span>`
  const tokenizer = /('[^']*')|(--[^\n]*)|(\b\d+\b)|([A-Za-z_]+)/g
  let out = '', last = 0, m: RegExpExecArray | null
  while ((m = tokenizer.exec(code))) {
    out += esc(code.slice(last, m.index))
    if (m[1]) out += wrap(m[1], 'var(--signal-green)')
    else if (m[2]) out += wrap(m[2], 'var(--text-faint)')
    else if (m[3]) out += wrap(m[3], 'var(--signal-amber)')
    else if (m[4]) {
      if (SQL_KW.test(m[4])) { SQL_KW.lastIndex = 0; out += wrap(m[4], 'var(--accent-primary)', true) }
      else out += esc(m[4])
    }
    last = tokenizer.lastIndex
  }
  out += esc(code.slice(last))
  return out
}
