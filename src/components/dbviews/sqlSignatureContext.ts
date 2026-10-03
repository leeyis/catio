import type { Tree } from '@lezer/common'
import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { dialectFor } from './sqlDialect'

export interface SqlCallContext { name: string; from: number; argument: number; namedArgument: number }

/** A bounded lexical walk, not SQL semantic validation. The editor reuses its
 * incremental CST so typing never serializes or reparses the whole document. */
function activeCall(code: string, tree: Tree, offset: number): SqlCallContext | null {
  const chars = code.split('')
  const end = offset + code.length
  let inComment = false, nodes = 0, exhausted = false
  tree.iterate({ from: offset, to: end, enter(node) {
    if (++nodes > 8_000) { exhausted = true; return false }
    if (!['String', 'QuotedIdentifier', 'LineComment', 'BlockComment'].includes(node.name)) return
    if (node.name.endsWith('Comment') && node.from < end && node.to >= end) {
      const closed = node.name === 'BlockComment' && node.to === end && code.endsWith('*/')
      if (!closed) inComment = true
    }
    for (let i = Math.max(0, node.from - offset); i < Math.min(chars.length, node.to - offset); i++) chars[i] = ' '
    return false
  } })
  if (inComment || exhausted) return null
  const masked = chars.join('')
  type Frame = { name: string | null; from: number; argument: number; namedArgument: number; query: boolean }
  const stack: Frame[] = []
  let previous: { text: string; from: number; to: number; qualified: boolean } | null = null
  let previousToken = ''
  for (const match of masked.matchAll(/[\p{L}_][\p{L}\p{N}_$]*|[()[\],;.]/gu)) {
    const token = match[0], pos = match.index!
    const frame = stack.at(-1)
    if (token === '(' || token === '[') {
      const callable = token === '(' && previous && /^[\p{L}_]/u.test(previous.text) && !masked.slice(previous.to, pos).trim()
      stack.push({ name: callable ? (previous!.qualified ? '' : previous!.text.toUpperCase()) : null,
        from: callable ? previous!.from : pos, argument: 0, namedArgument: 0, query: false })
    } else if (token === ')' || token === ']') stack.pop()
    else if (token === ';') stack.length = 0
    else if (frame) {
      if (token === ',') frame.argument++
      if (/^SELECT$/i.test(token)) frame.query = true
      if ((/^(?:TRY_)?CAST$/.test(frame.name ?? '') && /^AS$/i.test(token)) || (frame.name === 'EXTRACT' && /^FROM$/i.test(token))) frame.namedArgument = 1
    }
    previous = { text: token, from: pos, to: pos + token.length, qualified: previousToken === '.' }
    previousToken = token
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]
    if (frame.query) return null
    if (frame.name !== null) return { name: frame.name, argument: frame.argument, namedArgument: frame.namedArgument, from: offset + frame.from }
  }
  return null
}

export function sqlCallContext(code: string, cursor: number, engine?: string): SqlCallContext | null {
  if (code.length > 200_000 || cursor < 0 || cursor > code.length) return null
  return activeCall(code.slice(0, cursor), dialectFor(engine).language.parser.parse(code), 0)
}

export function sqlCallContextAt(state: EditorState): SqlCallContext | null {
  if (!state.selection.main.empty) return null
  const cursor = state.selection.main.head, tree = syntaxTree(state)
  if (cursor > tree.length) return null
  let node = tree.resolveInner(cursor, -1), start = 0
  while (node.parent) {
    if (node.name === 'Statement') { start = node.from; break }
    node = node.parent
  }
  // Don't window into a literal/comment or guess context beyond the budget.
  if (cursor - start > 20_000) return null
  return activeCall(state.sliceDoc(start, cursor), tree, start)
}
