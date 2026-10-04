import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { SyntaxNode } from '@lezer/common'
import { dialectFor } from './sqlDialect'
import { completionIdentifier as quote } from './sqlCompletionSchema'
export interface JoinForeignKey {
  column: string; refTable: string; refColumn: string
  refSchema?: string; constraintId?: string; ordinal?: number; columnCount?: number
}
export interface JoinTable { schema?: string; name: string; columns: string[]; foreignKeys: JoinForeignKey[] }
export interface JoinSuggestionItem { label: string; apply: string; detail: string }
type Id = { name: string; quoted: boolean; raw: string }
type Source = { table: JoinTable; alias?: Id }
const stops = new Set('where group having order limit offset fetch returning union intersect except qualify window for'.split(' '))
const modifiers = new Set('as on using join left right full inner outer cross natural lateral apply'.split(' '))
const identity = (table: JoinTable) => JSON.stringify([table.schema ?? '', table.name])
/** Only complete, identified constraints can produce executable JOIN suggestions. */
function groups(owner: JoinTable): JoinForeignKey[][] {
  const byId = new Map<string, JoinForeignKey[]>()
  for (const key of owner.foreignKeys) {
    if (!key.constraintId) continue
    const group = byId.get(key.constraintId) ?? []; group.push(key); byId.set(key.constraintId, group)
  }
  return [...byId.values()].filter(group => {
    const first = group[0], n = first.columnCount
    return Number.isInteger(n) && n! > 0 && group.length === n && group.every(key =>
      key.columnCount === n && key.refSchema === first.refSchema && key.refTable === first.refTable && !!key.column && !!key.refColumn
      && Number.isInteger(key.ordinal) && key.ordinal! > 0 && key.ordinal! <= n!
      && (!owner.columns.length || owner.columns.includes(key.column))) && new Set(group.map(key => key.ordinal)).size === n
  }).map(group => group.slice().sort((a, b) => a.ordinal! - b.ordinal!))
}
/** Uses only the nearest query block in the editor's incremental CST; never scans earlier statements with regexes. */
export function joinCompletion(context: CompletionContext, tables: JoinTable[], engine?: string, defaultSchema?: string): CompletionResult | null {
  if (!tables.length || tables.length > 5000) return null
  const { state, pos } = context, dialect = dialectFor(engine)
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 20_000), 10)
  if (!tree) return null
  let budget = 4000
  const text = (node: SyntaxNode) => state.sliceDoc(node.from, Math.min(node.to, pos))
  const word = (node?: SyntaxNode) => node ? text(node).toLowerCase() : ''
  const keyword = (node?: SyntaxNode) => node?.name === 'Keyword' ? word(node) : ''
  const children = (node: SyntaxNode): SyntaxNode[] => {
    const result: SyntaxNode[] = []
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (--budget < 0) return []
      if (!['LineComment', 'BlockComment', '(', ')', ';'].includes(n.name)) result.push(n)
    }
    return result
  }
  const id = (node?: SyntaxNode): Id | undefined => {
    if (!node || !['Identifier', 'QuotedIdentifier', 'Builtin', 'Type'].includes(node.name)) return
    const raw = text(node), quoted = node.name === 'QuotedIdentifier'
    if (!raw) return
    if (!quoted) return { raw, name: raw, quoted }
    const close = raw[0] === '[' ? ']' : raw[0]
    if (!raw.endsWith(close) || raw.length < 2) return
    return { raw, name: raw.slice(1, -1).split(close + close).join(close), quoted }
  }
  const path = (node?: SyntaxNode): Id[] => !node ? [] : node.name === 'CompositeIdentifier'
    ? children(node).flatMap(n => id(n) ? [id(n)!] : []) : id(node) ? [id(node)!] : []
  const matches = (name: Id, stored: string) => {
    if (dialect.spec.caseInsensitiveIdentifiers) return name.name.toLowerCase() === stored.toLowerCase()
    if (name.quoted) return name.name === stored
    if (['h2', 'oracle', 'oceanbase-oracle'].includes(engine ?? '')) return name.name.toUpperCase() === stored
    if (dialect === dialectFor('postgres') && engine !== 'duckdb') return name.name.toLowerCase() === stored
    return name.name.toLowerCase() === stored.toLowerCase()
  }
  let block: SyntaxNode | null = null
  const scopes: SyntaxNode[] = []
  const preceding = state.sliceDoc(Math.max(0, pos - 20_000), pos)
  const trailingSpace = preceding.length - preceding.trimEnd().length
  const cursorNode = tree.resolveInner(pos - trailingSpace, -1)
  for (let n: SyntaxNode | null = cursorNode; n; n = n.parent) {
    if (['String', 'LineComment', 'BlockComment'].includes(n.name)) return null
    if (n.name === 'Statement' || n.name === 'Parens' && ['select', 'with'].includes(word(children(n)[0]))) {
      if (!block) block = n
      scopes.push(n)
    }
  }
  if (!block || block.to - block.from > 200_000 || tree.length < block.to || block.to <= pos && state.sliceDoc(block.to - 1, block.to) === ';') return null
  const ctes: Id[] = []
  for (const scope of scopes) {
    const parts = children(scope)
    if (keyword(parts[0]) !== 'with') continue
    let i = keyword(parts[1]) === 'recursive' ? 2 : 1
    while (i < parts.length) {
      const name = id(parts[i++]); if (!name) break
      if (parts[i]?.name === 'Parens') i++
      if (keyword(parts[i++]) !== 'as') break
      if (keyword(parts[i]) === 'not') i++
      if (keyword(parts[i]) === 'materialized') i++
      if (parts[i++]?.name !== 'Parens') break
      ctes.push(name)
      if (word(parts[i]) !== ',') break
      i++
    }
  }
  const allTokens = children(block)
  let tokens = allTokens.filter(n => n.from < pos)
  // UNION arms do not share FROM bindings.
  let branch = 0
  for (let i = 0; i < tokens.length; i++) if (['union', 'intersect', 'except'].includes(keyword(tokens[i]))) branch = i + 1
  tokens = tokens.slice(branch)
  const from = tokens.findIndex(n => keyword(n) === 'from')
  if (from < 0 || budget < 0) return null
  const resolve = (names: Id[]): JoinTable | undefined => {
    if (names.length === 1 && ctes.some(cte => matches(names[0], cte.name))) return
    if (!names.length || names.length > 2) return
    const candidates = tables.filter(table => matches(names.at(-1)!, table.name) && (names.length === 2
      ? matches(names[0], table.schema ?? '') : defaultSchema !== undefined ? (table.schema ?? '') === defaultSchema : !table.schema))
    return candidates.length === 1 ? candidates[0] : undefined
  }
  const sources: Source[] = []
  let expecting = true, lastJoin = -1, lastOn = -1, pending: SyntaxNode | undefined
  for (let i = from + 1; i < tokens.length; i++) {
    const node = tokens[i], kw = keyword(node)
    if (stops.has(kw)) return null
    if (kw === 'cross' || kw === 'natural' || kw === 'apply' || kw === 'lateral') return null
    if (kw === 'join' || word(node) === ',') { expecting = true; lastJoin = i; pending = undefined; continue }
    if (kw === 'on') { lastOn = i; expecting = false; continue }
    if (!expecting || modifiers.has(kw)) continue
    expecting = false
    const names = path(node)
    // lang-sql splits doubled identifier quotes into adjacent quoted nodes.
    // Merge only touching tokens with the same delimiter, never spaced aliases.
    while (names.length && names.at(-1)!.quoted && tokens[i + 1]?.name === 'QuotedIdentifier' && tokens[i].to === tokens[i + 1].from) {
      const next = id(tokens[i + 1]), last = names.at(-1)!
      if (!next || next.raw[0] !== last.raw[0]) break
      const close = last.raw[0] === '[' ? ']' : last.raw[0]
      const raw = last.raw + next.raw
      names[names.length - 1] = { raw, quoted: true, name: raw.slice(1, -1).split(close + close).join(close) }
      i++
    }
    // The last, still-typed target is a prefix, not an already bound table.
    if (lastJoin >= 0 && i === tokens.length - 1 && node.to >= pos && !/\s$/.test(state.sliceDoc(node.from, pos))) { pending = node; continue }
    const table = resolve(names)
    let alias: Id | undefined
    if (keyword(tokens[i + 1]) === 'as') { alias = id(tokens[i + 2]); i += 2 }
    else if (id(tokens[i + 1]) && !modifiers.has(keyword(tokens[i + 1]))) alias = id(tokens[++i])
    if (table) sources.push({ table, alias })
    else if (lastJoin >= 0) return null // An unresolved joined target must not bind to another physical table.
  }
  if (!sources.length || budget < 0) return null
  const qtable = (table: JoinTable) => table.schema ? `${quote(table.schema, engine)}.${quote(table.name, engine)}` : quote(table.name, engine)
  const ref = (source: Source) => source.alias ? source.alias.quoted ? quote(source.alias.name, engine) : source.alias.raw : qtable(source.table)
  const displayRef = (source: Source) => source.alias?.name ?? source.table.name
  const options: { label: string; apply: string; detail: string; type: string; boost: number }[] = []
  const seen = new Set<string>()
  const add = (owner: Source, target: Source, keys: JoinForeignKey[], mode: 'condition' | 'table' | 'join' | 'target', added?: JoinTable) => {
    if (target.table.columns.length && keys.some(key => !target.table.columns.includes(key.refColumn))) return
    const condition = keys.map(key => `${ref(owner)}.${quote(key.column, engine)} = ${ref(target)}.${quote(key.refColumn, engine)}`).join(' AND ')
    const labelCondition = keys.map(key => `${displayRef(owner)}.${key.column} = ${displayRef(target)}.${key.refColumn}`).join(' AND ')
    const label = mode === 'condition' ? labelCondition : `JOIN ${added!.schema ? added!.schema + '.' : ''}${added!.name} ON ${labelCondition}`
    const apply = mode === 'condition' ? condition : mode === 'target' ? qtable(added!) : `${mode === 'join' ? 'JOIN ' : ''}${qtable(added!)} ON ${condition}`
    if (seen.has(apply)) return
    seen.add(apply); options.push({ label, apply, detail: `FK JOIN${keys.length > 1 ? ` (${keys.length})` : ''}`, type: 'snippet', boost: 50 })
  }
  let replaceFrom = pos
  const replaceTo = pending ? pending.to : pos
  if (lastOn > lastJoin && sources.length >= 2) {
    const tail = state.sliceDoc(pos, block.to).replace(/[);\s]+$/, '').trim()
    const nextToken = allTokens.find(n => n.from >= pos)
    if (tail && !(nextToken?.name === 'Keyword' && stops.has(state.sliceDoc(nextToken.from, nextToken.to).toLowerCase()))) return null
    const on = tokens[lastOn]
    const prefix = state.sliceDoc(on.to, pos).trim()
    if (!prefix || /^[\p{L}\p{N}_$."`\[\]]+$/u.test(prefix)) {
      replaceFrom = on.to + state.sliceDoc(on.to, pos).search(/\S|$/)
      const latest = sources.at(-1)!
      for (const previous of sources.slice(0, -1)) for (const [owner, target] of [[previous, latest], [latest, previous]]) {
        for (const keys of groups(owner.table)) if ((keys[0].refSchema ?? owner.table.schema ?? '') === (target.table.schema ?? '') && keys[0].refTable === target.table.name) add(owner, target, keys, 'condition')
      }
      return options.length ? { from: replaceFrom, to: replaceTo, options, filter: false } : null
    }
    return null
  }
  const following = pending ? allTokens.filter(n => n.from >= pending!.to) : []
  const preserveSuffix = following.length > 0 && (following[0].name === 'Keyword'
    ? ['on', 'using', 'as'].includes(state.sliceDoc(following[0].from, following[0].to).toLowerCase())
    : ['Identifier', 'QuotedIdentifier', 'Builtin', 'Type'].includes(following[0].name))
  const mode = pending && preserveSuffix ? 'target' : lastJoin >= 0 && (expecting || pending) ? 'table' : 'join'
  if (mode === 'join' && !/\s$/.test(state.sliceDoc(block.from, pos))) return null
  if (pending) replaceFrom = pending.from
  const prefix = pending ? state.sliceDoc(pending.from, pos).toLowerCase() : ''
  const targetMatches = (table: JoinTable) => !prefix || table.name.toLowerCase().startsWith(prefix) || `${table.schema ?? ''}.${table.name}`.toLowerCase().startsWith(prefix)
  const existing = new Set(sources.map(source => identity(source.table)))
  for (const anchor of sources) {
    for (const keys of groups(anchor.table)) {
      const target = tables.find(table => table.name === keys[0].refTable && (table.schema ?? '') === (keys[0].refSchema ?? anchor.table.schema ?? ''))
      if (target && !existing.has(identity(target)) && targetMatches(target)) add(anchor, { table: target }, keys, mode, target)
    }
    for (const other of tables) {
      if (existing.has(identity(other)) || !targetMatches(other)) continue
      for (const keys of groups(other)) if (keys[0].refTable === anchor.table.name && (keys[0].refSchema ?? other.schema ?? '') === (anchor.table.schema ?? '')) add({ table: other }, anchor, keys, mode, other)
    }
  }
  return options.length ? { from: replaceFrom, to: replaceTo, options, filter: false } : null
}
/** Pure helper for callers without an editor. The live path reuses its existing incremental parser. */
export function joinSuggestions(before: string, tables: JoinTable[], engine?: string, defaultSchema?: string): JoinSuggestionItem[] {
  const state = EditorState.create({ doc: before, extensions: [sql({ dialect: dialectFor(engine) })] })
  return (joinCompletion(new CompletionContext(state, before.length, true), tables, engine, defaultSchema)?.options ?? [])
    .map(option => ({ label: option.label, apply: option.apply as string, detail: option.detail! }))
}
