import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { schemaCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']
import { completionIdentifier } from './sqlCompletionSchema'
import { dialectFor } from './sqlDialect'
import { sqlIdentifierKey,sqlIdentifierMatches } from './sqlIdentifiers'

type Id = { name: string; quoted: boolean }
type Binding = { id: Id; columns: Completion[] }
type Bindings = Map<string, Binding>
interface Scope { relations: Bindings; ctes: Bindings; output: Completion[]; childOuter: Bindings }
const stops = new Set('where group having order limit offset fetch returning union intersect except qualify window for'.split(' '))
const modifiers = new Set('as on using join left right full inner outer cross natural with'.split(' '))
const tableHints = new Set('nolock holdlock updlock rowlock paglock tablock tablockx xlock readpast nowait readcommitted readcommittedlock readuncommitted repeatableread serializable snapshot index forcescan forceseek'.split(' '))

/** Bounded, tolerant query-scope analysis over the editor's existing incremental CST.
 * This is a completion aid, NOT a SQL validator or an execution/authorization boundary.
 * Only projected identifiers, explicit aliases/lists and resolvable stars are inferred.
 * Unknown expressions are left unknown instead of inventing output column names.
 */
export function scopedSchemaCompletion(schema: SQLNamespace, defaultSchema?: string, engine?: string): CompletionSource {
  const dialect = dialectFor(engine)
  const sqlServer = dialect === dialectFor('sqlserver')
  const supportsLateral = ['postgres','mysql','mariadb','oracle'].some(id=>dialect===dialectFor(id))
  const supportsApply = sqlServer || dialect === dialectFor('oracle')
  const implicitRecursive = sqlServer || dialect === dialectFor('oracle') || dialect === dialectFor('sqlite')
  const isModifier = (value:string) => modifiers.has(value) || value==='lateral'&&supportsLateral || value==='apply'&&supportsApply
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
    const key = (value: Id) => sqlIdentifierKey(value,engine)
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
      const matches = Object.keys(object).filter(k => sqlIdentifierMatches(name,k.replace(/\\\./g, '.'),engine))
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
    const derivedQuery = (node:SyntaxNode):SyntaxNode|undefined => {
      for(let depth=0;depth<=12;depth++) {
        if(queryNode(node))return node
        const parts=children(node)
        if(parts.length!==1||parts[0].name!=='Parens')return
        node=parts[0]
      }
      budget=-1
    }
    const analyze = (node: SyntaxNode, inherited: Bindings, depth = 0, at?: number, outer:Bindings=new Map()): Scope => {
      const empty: Scope = { ctes: new Map(inherited), relations: new Map(outer), output: [], childOuter:new Map(outer) }
      if (depth > 12 || --budget < 0) { budget=-1;return empty }
      let tokens = children(node)
      budget -= tokens.length
      if (budget < 0) return empty
      const ctes = empty.ctes
      let start = 0
      if (word(tokens[0]) === 'with') {
        const recursive = word(tokens[1]) === 'recursive'
        start = recursive ? 2 : 1
        const definitions:{name:Id;explicit?:Id[];body:SyntaxNode}[]=[]
        while (start < tokens.length) {
          const name = id(tokens[start++]); if (!name) break
          let explicit: Id[] | undefined
          if (tokens[start]?.name === 'Parens') {
            const names=children(tokens[start++]);budget-=names.length
            explicit=names.flatMap(n=>id(n)?[id(n)!]:[])
          }
          if (word(tokens[start++]) !== 'as') break
          if (word(tokens[start]) === 'not') start++
          if (word(tokens[start]) === 'materialized') start++
          const body = tokens[start++]; if (!body || body.name !== 'Parens') break
          definitions.push({name,explicit,body})
          if (word(tokens[start]) !== ',') break
          start++
        }
        // Forward CTEs must shadow same-named physical tables even before their
        // output can be inferred. Only explicitly declared columns are known yet.
        if(recursive||dialect===dialectFor('sqlite'))for(const def of definitions)
          ctes.set(key(def.name),{id:def.name,columns:def.explicit?.map(projected)??[]})
        for(const {name,explicit,body} of definitions) {
          if (recursive || implicitRecursive) ctes.set(key(name), { id: name, columns: explicit?.map(projected) ?? [] })
          if (at !== undefined && at >= body.from && at < body.to) return empty
          const output = explicit ? explicit.map(projected) : analyze(body, ctes, depth + 1,undefined,outer).output
          ctes.set(key(name), { id: name, columns: output })
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
      const relations = empty.relations, locals:Bindings=new Map()
      let childOuter:Bindings|undefined, argumentScope:Bindings|undefined
      const from = tokens.findIndex(n => word(n) === 'from')
      const hint=(node?:SyntaxNode)=>sqlServer&&node?.name==='Parens'&&tableHints.has(word(children(node)[0]))
      if (from >= 0) {
        let expecting = true, lateral=false
        for (let i = from + 1; i < tokens.length; i++) {
          const token = tokens[i], value = word(token)
          if (stops.has(value)) break
          if (value === 'join' || value === ',' || value === 'apply'&&supportsApply) {
            expecting = true;lateral=value==='apply';continue
          }
          if(expecting&&value==='lateral'&&supportsLateral){lateral=true;continue}
          if (!expecting || isModifier(value)) continue
          expecting = false
          const names = path(token)
          const nested = token.name === 'Parens' ? derivedQuery(token) : undefined
          if (!nested && (!names.length || text(token).trimEnd().endsWith('.'))) continue
          // A derived table is a correlation boundary. LATERAL/APPLY sees only
          // preceding siblings, never itself or later JOIN targets. Ordinary
          // derived tables retain genuine outer-query bindings, not same-level ones.
          const accessible=new Map(lateral||engine==='duckdb'?relations:outer)
          if(nested&&at!==undefined&&at>=token.from&&at<token.to)childOuter=accessible
          const functionArgs=!nested&&tokens[i+1]?.name==='Parens'&&!hint(tokens[i+1])
          if(functionArgs&&at!==undefined&&at>=tokens[i+1].from&&at<tokens[i+1].to) {
            // FROM-function arguments are lateral in known supporting dialects.
            // Preserve only prior inputs, also for scalar subqueries in arguments.
            argumentScope=new Map(lateral||supportsLateral||dialect===dialectFor('sqlite')?relations:outer)
            childOuter=argumentScope
          }
          let cols = nested ? analyze(nested, ctes, depth + 1,undefined,accessible).output
            : functionArgs ? [] : names.length === 1 && ctes.has(key(names[0])) ? ctes.get(key(names[0]))!.columns : physicalColumns(names)
          if(functionArgs||hint(tokens[i+1]))i++
          if(functionArgs&&word(tokens[i+1])==='with'&&word(tokens[i+2])==='ordinality')i+=2
          let alias: Id | undefined
          if (word(tokens[i + 1]) === 'as') { alias = id(tokens[i + 2]); i += 2 }
          else if (id(tokens[i + 1]) && !stops.has(word(tokens[i + 1])) && !isModifier(word(tokens[i + 1]))) alias = id(tokens[++i])
          if(word(tokens[i+1])==='with'&&hint(tokens[i+2]))i+=2
          else if(hint(tokens[i+1]))i++
          else if(tokens[i+1]?.name==='Parens'&&(!sqlServer||nested)) {
            const renamed=children(tokens[++i]).flatMap(n=>id(n)?[projected(id(n)!)]:[])
            if(renamed.length)cols=cols.length&&renamed.length>cols.length?[]:[...renamed,...cols.slice(renamed.length)]
          }
          const binding = alias ?? names.at(-1)
          if (binding) {
            const value={id:binding,columns:locals.has(key(binding))?[]:cols}
            locals.set(key(binding),value);relations.set(key(binding),value)
          }
          lateral=false
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
          else if (part.length === 1 && text(part[0]) === '*') for (const binding of locals.values()) output.push(...binding.columns)
          else if (part.length === 1 && path(part[0]).length && !text(part[0]).trimEnd().endsWith('.')) output.push(projected(path(part[0]).at(-1)!))
          else if (part.length && /\.\s*\*$/.test(state.sliceDoc(part[0].from, part.at(-1)!.to))) {
            const owner = path(part[0])[0]; if (owner) output.push(...(relations.get(key(owner))?.columns ?? []))
          }
          part = []
        }
        for (const token of projection) { if (word(token) === ',') emit(); else part.push(token) }
        emit()
      }
      return { ctes, relations:argumentScope??relations, output, childOuter:childOuter??new Map(relations) }
    }
    let scope: Scope = { relations: new Map(), ctes: new Map(), output: [],childOuter:new Map() }
    for (const ancestor of ancestors) scope = analyze(ancestor, scope.ctes, 0, pos,scope.childOuter)
    if (budget < 0) return null
    // Bindings include only lexically visible correlations. An unresolved alias
    // must never fall back to lang-sql's statement-wide scanner across boundaries.
    if (leaf.name === '⚠' && leaf.prevSibling) leaf = leaf.prevSibling
    let composite: SyntaxNode | null = leaf
    while (composite && composite.name !== 'CompositeIdentifier') composite = composite.parent
    if (composite) {
      const tokens = children(composite)
      const dots = tokens.filter(n => n.name === '.' && n.to <= pos)
      const qualifier = path(composite)[0]
      const binding = dots.length === 1 && qualifier ? scope.relations.get(key(qualifier)) : undefined
      if(!dots.length)return fallback(context) as CompletionResult|null
      let values:readonly Completion[]
      if(binding)values=binding.columns
      else {
        // Navigate metadata directly. The library fallback also scans aliases
        // across the whole statement, including invisible namespace-named aliases.
        const names=path(composite)
        let level:SQLNamespace|undefined=schema
        for(let i=0;i<dots.length&&level;i++)level=names[i]?lookup(level,names[i]):undefined
        if(!level)return {from:pos,options:[]}
        const data=unwrap(level)
        values=Array.isArray(data)?data.map(c=>typeof c==='string'?column(c):c):Object.entries(data).map(([key,value])=>{
          const self=(value as {self?:Completion}).self
          const name=key.replace(/\\\./g,'.')
          return self??{label:name,type:'type',apply:completionIdentifier(name,engine)}
        })
      }
      const current = tokens.find(n => n.from >= dots.at(-1)!.to && n.from < pos && id(n))
      const quote = current?.name === 'QuotedIdentifier' ? text(current)[0] : undefined
      const close = quote === '[' ? ']' : quote
      const options = values.map(c => ({ ...c, apply: quote ? quote + c.label.split(close!).join(close! + close!) + close : c.apply }))
      return { from: current?.from ?? pos, to: close && state.sliceDoc(pos, pos + 1) === close ? pos + 1 : undefined, options }
    }
    const base = fallback(context) as CompletionResult | null
    if (scope.ctes.size && !composite && base) {
      return { ...base, options: [...base.options, ...[...scope.ctes.values()].map(c => ({ ...projected(c.id), type: 'type' }))] }
    }
    return base
  }
}
