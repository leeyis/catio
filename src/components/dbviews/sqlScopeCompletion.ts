import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { schemaCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']
import { completionIdentifier } from './sqlCompletionSchema'
import { dialectFor } from './sqlDialect'

type Id = { name: string; quoted: boolean }
type Binding = { id: Id; columns: Completion[] }
type Bindings = Map<string, Binding>
interface Scope { relations: Bindings; ctes: Bindings; output: Completion[] }
const stops = new Set('where group having order limit offset fetch returning union intersect except qualify window for'.split(' '))
const modifiers = new Set('as on using join left right full inner outer cross natural lateral apply'.split(' '))

/** Bounded, tolerant query-scope analysis over the editor's existing incremental CST.
 * This is a completion aid, NOT a SQL validator or an execution/authorization boundary.
 * Only projected identifiers, explicit aliases/lists and resolvable stars are inferred.
 * Unknown expressions are left unknown instead of inventing output column names.
 */
export function scopedSchemaCompletion(schema: SQLNamespace, defaultSchema?: string, engine?: string): CompletionSource {
  const dialect = dialectFor(engine)
  const fallback = schemaCompletionSource({ schema, defaultSchema, dialect })
  return (context: CompletionContext): CompletionResult | null => {
    const { state, pos } = context
    const text = (node: SyntaxNode) => state.sliceDoc(node.from, node.to)
    const word = (node?: SyntaxNode) => node ? text(node).toLowerCase() : ''
    const id = (node?: SyntaxNode | null): Id | undefined => {
      if (!node || !/^(Identifier|QuotedIdentifier|Keyword|Builtin|Type)$/.test(node.name)) return
      const raw = text(node)
      if (node.name !== 'QuotedIdentifier') return { name: raw, quoted: false }
      const close = raw[0] === '[' ? ']' : raw[0]
      const body = raw.endsWith(close) ? raw.slice(1, -1) : raw.slice(1)
      return { name: body.split(close + close).join(close), quoted: true }
    }
    const key = (value: Id) => {
      if (dialect.spec.caseInsensitiveIdentifiers) return value.name.toLowerCase()
      if (value.quoted) return value.name
      return ['h2', 'oracle', 'oceanbase-oracle'].includes(engine ?? '') ? value.name.toUpperCase() : value.name.toLowerCase()
    }
    const children = (node: SyntaxNode): SyntaxNode[] => {
      const result: SyntaxNode[] = []
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (!['LineComment', 'BlockComment', '(', ')', ';'].includes(child.name)) result.push(child)
      }
      return result
    }
    const path = (node?: SyntaxNode): Id[] => !node ? [] : node.name === 'CompositeIdentifier'
      ? children(node).flatMap(child => { const name = id(child); return name ? [name] : [] })
      : id(node) ? [id(node)!] : []
    const column = (name: string): Completion => ({ label: name, type: 'property', apply: completionIdentifier(name, engine), boost: 10 })
    const projected = (name: Id): Completion => {
      const foldsCase = (dialect === dialectFor('postgres') && engine !== 'duckdb') || ['h2', 'oracle', 'oceanbase-oracle'].includes(engine ?? '')
      if (name.quoted || foldsCase) return column(name.quoted ? name.name : key(name))
      // Unknown JDBC folding rules must not turn an unquoted alias into a differently-cased quoted name.
      return { ...column(name.name), apply: name.name }
    }
    const unwrap = (ns: SQLNamespace): SQLNamespace => {
      const tagged = ns as { self?: Completion; children?: SQLNamespace }
      return tagged.self && typeof tagged.self.label === 'string' && tagged.children ? tagged.children : ns
    }
    const lookup = (ns: SQLNamespace | undefined, name: Id): SQLNamespace | undefined => {
      if (!ns) return
      const object = unwrap(ns) as Record<string, SQLNamespace>
      if (Array.isArray(object)) return
      const escaped = name.name.replace(/\./g, '\\.')
      if (Object.prototype.hasOwnProperty.call(object, escaped)) return object[escaped]
      if (name.quoted && !dialect.spec.caseInsensitiveIdentifiers) return
      const matches = Object.keys(object).filter(k => k.replace(/\\\./g, '.').toLowerCase() === name.name.toLowerCase())
      return matches.length === 1 ? object[matches[0]] : undefined
    }
    const physicalColumns = (names: Id[]): Completion[] => {
      let level: SQLNamespace | undefined = schema
      if (names.length === 1 && defaultSchema) level = lookup(level, { name: defaultSchema, quoted: true })
      for (const name of names) level = lookup(level, name)
      if (!level) return []
      const values = unwrap(level)
      return Array.isArray(values) ? values.map(value => typeof value === 'string' ? column(value) : value) : []
    }
    const queryNode = (node: SyntaxNode) => node.name === 'Statement' || node.name === 'Parens' && /^(select|with)$/i.test(word(children(node)[0]))
    // A cached tree may lag just after input (especially under load). Finish a
    // bounded lookahead before resolving aliases defined AFTER the cursor.
    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 20_000), 10)
    if (!tree) return null
    let leaf = tree.resolveInner(pos, -1)
    for (let n: SyntaxNode | null = leaf; n; n = n.parent) if (['String', 'LineComment', 'BlockComment'].includes(n.name)) return null
    const ancestors: SyntaxNode[] = []
    for (let n: SyntaxNode | null = leaf; n; n = n.parent) if (queryNode(n)) ancestors.unshift(n)
    if (!ancestors.length) return fallback(context) as CompletionResult | null
    if (tree.length < state.doc.length && ancestors[0].to >= tree.length && state.sliceDoc(tree.length - 1, tree.length) !== ';') return null
    if (ancestors[0].to - ancestors[0].from > 200_000) return null

    let budget = 4000
    const analyze = (node: SyntaxNode, inherited: Bindings, depth = 0, at?: number): Scope => {
      const empty: Scope = { ctes: new Map(inherited), relations: new Map(), output: [] }
      if (depth > 12 || --budget < 0) return empty
      let tokens = children(node)
      budget -= tokens.length
      if (budget < 0) return empty
      const ctes = empty.ctes
      let start = 0
      if (word(tokens[0]) === 'with') {
        const recursive = word(tokens[1]) === 'recursive'
        start = recursive ? 2 : 1
        while (start < tokens.length) {
          const name = id(tokens[start++]); if (!name) break
          let explicit: Id[] | undefined
          if (tokens[start]?.name === 'Parens') explicit = children(tokens[start++]).flatMap(n => id(n) ? [id(n)!] : [])
          if (word(tokens[start++]) !== 'as') break
          if (word(tokens[start]) === 'not') start++
          if (word(tokens[start]) === 'materialized') start++
          const body = tokens[start++]; if (!body || body.name !== 'Parens') break
          // Explicit lists allow safe recursive self-reference. No guessed recursive output names.
          if (recursive) ctes.set(key(name), { id: name, columns: explicit?.map(projected) ?? [] })
          // A cursor inside this definition sees prior CTEs, not later siblings (nor itself unless recursive).
          if (at !== undefined && at >= body.from && at < body.to) return empty
          const output = explicit ? explicit.map(projected) : analyze(body, ctes, depth + 1).output
          ctes.set(key(name), { id: name, columns: output })
          if (word(tokens[start]) !== ',') break
          start++
        }
      }
      tokens = tokens.slice(start)
      // Each UNION/INTERSECT/EXCEPT arm has its own aliases; output names come from the first arm.
      let branchStart = 0, branchEnd = tokens.length
      for (let i = 0; i < tokens.length; i++) if (['union', 'intersect', 'except'].includes(word(tokens[i]))) {
        if (at !== undefined && tokens[i].from < at) branchStart = i + 1
        else { branchEnd = i; break }
      }
      tokens = tokens.slice(branchStart, branchEnd)
      const relations = empty.relations
      const from = tokens.findIndex(n => word(n) === 'from')
      if (from >= 0) {
        let expecting = true
        for (let i = from + 1; i < tokens.length; i++) {
          const token = tokens[i], value = word(token)
          if (stops.has(value)) break
          if (value === 'join' || value === ',' || value === 'apply') { expecting = true; continue }
          if (!expecting || modifiers.has(value)) continue
          expecting = false
          const names = path(token)
          const nested = token.name === 'Parens' && queryNode(token)
          if (!nested && !names.length) continue
          const cols = nested ? analyze(token, ctes, depth + 1).output
            : names.length === 1 && ctes.has(key(names[0])) ? ctes.get(key(names[0]))!.columns : physicalColumns(names)
          let alias: Id | undefined
          if (word(tokens[i + 1]) === 'as') { alias = id(tokens[i + 2]); i += 2 }
          else if (id(tokens[i + 1]) && !stops.has(word(tokens[i + 1])) && !modifiers.has(word(tokens[i + 1]))) alias = id(tokens[++i])
          const binding = alias ?? names.at(-1)
          if (binding) relations.set(key(binding), { id: binding, columns: cols })
        }
      }
      const select = tokens.findIndex(n => word(n) === 'select')
      const output: Completion[] = []
      if (select >= 0) {
        const projection = tokens.slice(select + 1, from < 0 ? tokens.length : from)
        let part: SyntaxNode[] = []
        const emit = () => {
          if (['distinct', 'all'].includes(word(part[0]))) part = part.slice(1)
          const as = part.findIndex(n => word(n) === 'as')
          const alias = as >= 0 ? id(part[as + 1]) : undefined
          if (alias) output.push(projected(alias))
          else if (part.length === 1 && text(part[0]) === '*') for (const binding of relations.values()) output.push(...binding.columns)
          else if (part.length === 1 && path(part[0]).length) output.push(projected(path(part[0]).at(-1)!))
          else if (part.length && /\.\s*\*$/.test(state.sliceDoc(part[0].from, part.at(-1)!.to))) {
            const owner = path(part[0])[0]; if (owner) output.push(...(relations.get(key(owner))?.columns ?? []))
          }
          part = []
        }
        for (const token of projection) { if (word(token) === ',') emit(); else part.push(token) }
        emit()
      }
      return { ctes, relations, output }
    }
    let scope: Scope = { relations: new Map(), ctes: new Map(), output: [] }
    for (const ancestor of ancestors) scope = analyze(ancestor, scope.ctes, 0, pos)
    if (budget < 0) return null
    // Resolve only the nearest block's relation bindings. In particular, a shadowed outer
    // alias must not fall back to lang-sql's statement-wide alias scanner.
    if (leaf.name === '⚠' && leaf.prevSibling) leaf = leaf.prevSibling
    let composite: SyntaxNode | null = leaf
    while (composite && composite.name !== 'CompositeIdentifier') composite = composite.parent
    if (composite) {
      const tokens = children(composite)
      const dots = tokens.filter(n => n.name === '.' && n.to <= pos)
      const qualifier = path(composite)[0]
      const binding = dots.length === 1 && qualifier ? scope.relations.get(key(qualifier)) : undefined
      if (binding) {
        const current = tokens.find(n => n.from >= dots[0].to && n.from < pos && id(n))
        const quote = current?.name === 'QuotedIdentifier' ? text(current)[0] : undefined
        const close = quote === '[' ? ']' : quote
        const options = binding.columns.map(c => ({ ...c, apply: quote ? quote + c.label.split(close!).join(close! + close!) + close : c.apply }))
        return { from: current?.from ?? pos, to: close && state.sliceDoc(pos, pos + 1) === close ? pos + 1 : undefined, options }
      }
    }
    const base = fallback(context) as CompletionResult | null
    if (scope.ctes.size && !composite && base) {
      return { ...base, options: [...base.options, ...[...scope.ctes.values()].map(c => ({ ...projected(c.id), type: 'type' }))] }
    }
    return base
  }
}
