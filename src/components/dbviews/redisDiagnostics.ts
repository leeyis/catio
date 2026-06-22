/**
 * Redis command syntax diagnostics for the query editor (CodeMirror linter).
 * Modeled on dbx's redisSyntaxDiagnostics.ts but emitting native CodeMirror
 * `Diagnostic`s and backed by catio's full generated command table — so arity,
 * unknown-command, unclosed-quote and blocked/write checks all light up inline.
 *
 * One Redis command per line (matches the execution contract). The per-line
 * planner is pure (unit-tested); `redisLinter` walks the doc and maps spans to
 * absolute offsets. The cursor line is linted leniently (only hard errors like a
 * blocked command) so typing doesn't flash red mid-entry.
 */
import type { Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { REDIS_COMMANDS } from './redisCommands.generated'
import { resolveRedisDoc, isRedisContainer } from './redisCompletion'

export interface RedisToken { value: string; startCol: number; endCol: number }
export interface RedisTokenizeResult { argv: RedisToken[]; unclosedQuote: boolean; unclosedQuoteStart?: number }

/** Tokenize one Redis line into argv, mirroring the backend parse_command_argv
 *  rules (whitespace split, single/double quotes, backslash escapes, trailing ;). */
export function tokenizeRedisLine(line: string): RedisTokenizeResult {
  const argv: RedisToken[] = []
  let i = 0
  const n = line.length
  let unclosedQuote = false
  let unclosedQuoteStart: number | undefined

  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++
    if (i >= n) break
    const startCol = i + 1 // 1-based
    let value = ''
    let closed = false
    const ch = line[i]

    if (ch === '"' || ch === "'") {
      if (unclosedQuoteStart === undefined) unclosedQuoteStart = startCol
      const quote = ch
      i++
      let escaping = false
      while (i < n) {
        const c = line[i]
        if (escaping) { value += c; escaping = false; i++; continue }
        if (c === '\\') { escaping = true; i++; continue }
        if (c === quote) { i++; closed = true; break }
        value += c; i++
      }
      if (!closed && i >= n) unclosedQuote = true
      else while (i < n && line[i] !== ' ' && line[i] !== '\t') { value += line[i]; i++ }
    } else {
      closed = true
      while (i < n && line[i] !== ' ' && line[i] !== '\t') {
        if (line[i] === '\\') { i++; if (i < n) { value += line[i]; i++ } ; continue }
        value += line[i]; i++
      }
    }
    if (value.endsWith(';')) value = value.slice(0, -1)
    if (value.length > 0 || !closed) argv.push({ value, startCol, endCol: i + 1 })
  }
  return { argv, unclosedQuote, unclosedQuoteStart }
}

function aritySatisfied(arity: number, tokenCount: number): boolean {
  if (arity > 0) return tokenCount === arity
  if (arity < 0) return tokenCount >= -arity
  return true
}

function describeArity(arity: number): string {
  if (arity > 0) { const n = arity - 1; return `精确 ${n} 个参数` }
  const n = -arity - 1
  return `至少 ${n} 个参数`
}

// Set of main command names, to gate "unknown command" while the user is still
// typing a valid prefix (e.g. "GE" shouldn't error — it's a prefix of GET/GETDEL).
const MAIN_NAMES: string[] = []
for (const key of Object.keys(REDIS_COMMANDS)) {
  const head = key.split(' ')[0]
  if (!MAIN_NAMES.includes(head)) MAIN_NAMES.push(head)
}
function isCommandPrefix(token: string): boolean {
  const u = token.toUpperCase()
  return MAIN_NAMES.some(n => n.startsWith(u))
}

export interface RedisLineDiag { startCol: number; endCol: number; severity: 'error' | 'warning'; message: string }

/**
 * Diagnose one Redis line. `lenient` (the cursor line) suppresses unknown/arity
 * noise while typing, keeping only hard signals (blocked command).
 */
export function redisLineDiagnostics(line: string, lenient = false): RedisLineDiag[] {
  if (!line.trim() || /^\s*(#|--)/.test(line)) return []
  const { argv, unclosedQuote, unclosedQuoteStart } = tokenizeRedisLine(line)

  if (unclosedQuote && !lenient) {
    const startCol = unclosedQuoteStart ?? 1
    return [{ startCol, endCol: Math.max(line.length + 1, startCol + 1), severity: 'error', message: '未闭合的引号' }]
  }
  if (argv.length === 0) return []

  const upper = argv.map(t => t.value.toUpperCase())
  const head = argv[0]
  const doc = resolveRedisDoc(upper)

  if (!doc) {
    // Container typed without (or before) a subcommand → not an error yet.
    if (isRedisContainer(upper[0])) {
      if (argv.length >= 2 && !lenient) {
        const sub = argv[1]
        return [{ startCol: sub.startCol, endCol: sub.endCol, severity: 'error', message: `未知子命令 '${argv[1].value}'` }]
      }
      return []
    }
    if (lenient || isCommandPrefix(argv[0].value)) return []
    return [{ startCol: head.startCol, endCol: head.endCol, severity: 'error', message: `未知命令 '${argv[0].value}'` }]
  }

  // Blocked is a hard signal — report even on the cursor line.
  if (doc.safety === 'blocked') {
    return [{ startCol: head.startCol, endCol: head.endCol, severity: 'error', message: `命令 '${argv[0].value}' 在控制台中已禁用(破坏性/管理类)` }]
  }
  if (lenient) return []

  if (!aritySatisfied(doc.arity, argv.length)) {
    return [{ startCol: head.startCol, endCol: head.endCol, severity: 'error', message: `参数数量不对:'${argv[0].value}' 需要${describeArity(doc.arity)},实际 ${argv.length - 1} 个` }]
  }
  if (doc.safety === 'confirm') {
    return [{ startCol: head.startCol, endCol: head.endCol, severity: 'warning', message: `写命令 '${argv[0].value}' — 会修改数据` }]
  }
  return []
}

/** CodeMirror linter source for the Redis console. */
export function redisLinter(view: EditorView): Diagnostic[] {
  const doc = view.state.doc
  const cursorLineNo = doc.lineAt(view.state.selection.main.head).number
  const out: Diagnostic[] = []
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const diags = redisLineDiagnostics(line.text, i === cursorLineNo)
    for (const d of diags) {
      out.push({ from: line.from + d.startCol - 1, to: line.from + d.endCol - 1, severity: d.severity, message: d.message })
    }
  }
  return out
}
