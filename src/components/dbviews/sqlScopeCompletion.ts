import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { schemaCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']
import { completionIdentifier } from './sqlCompletionSchema'
import { dialectFor } from './sqlDialect'
import { sqlIdentifierKey,sqlIdentifierMatches } from './sqlIdentifiers'
import { sqlColumnContext } from './sqlColumnContext'
import { sqlWriteContext } from './sqlWriteCompletion'

type Id = { name: string; quoted: boolean }
type Binding = { id: Id; columns: Completion[]; qualifier?: string }
type Bindings = Map<string, Binding>
interface Scope {
  relations: Bindings; ctes: Bindings; output: Completion[]; childOuter: Bindings
  locals: Bindings; context: ReturnType<typeof sqlColumnContext>; using?: Completion[]; compoundOrder?: boolean
}
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
    // Keywords are short tokens, never a whole parenthesized query body.
    const word = (node?: SyntaxNode) => node && node.to-node.from<=32 ? text(node).toLowerCase() : ''
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
      if(!Array.isArray(values))return []
      budget-=values.length
      return budget<0?[]:values.map(value => typeof value === 'string' ? column(value) : value)
    }
    const queryNode = (node: SyntaxNode) => node.name === 'Statement' || node.name === 'Parens' && /^(select|with)$/i.test(word(children(node)[0]))
    // A cached tree may lag just after input (especially under load). Finish a
    // bounded lookahead before resolving aliases defined AFTER the cursor.
    const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 20_000), 10)
    if (!tree) return null
    let leaf = tree.resolveInner(pos, -1)
    // Whitespace after the last token belongs to an unfinished statement, but
    // never inherit a completed statement across its semicolon.
    if(leaf.name==='Script') {
      const previous=leaf.childBefore(pos)
      if(previous?.name==='Statement'&&previous.lastChild?.name!==';'&&pos-previous.to<=20_000&&/^\s*$/.test(state.sliceDoc(previous.to,pos)))leaf=previous
    }
    for (let n: SyntaxNode | null = leaf; n; n = n.parent) if (['String', 'LineComment', 'BlockComment'].includes(n.name)) return null
    const ancestors: SyntaxNode[] = []
    for (let n: SyntaxNode | null = leaf; n; n = n.parent) if (queryNode(n)) ancestors.unshift(n)
    if (!ancestors.length) return fallback(context) as CompletionResult | null
    if (tree.length < state.doc.length && ancestors[0].to >= tree.length && state.sliceDoc(tree.length - 1, tree.length) !== ';') return null
    if (ancestors[0].to - ancestors[0].from > 200_000) return null

    let budget = 4000
    const writeContext = sqlWriteContext(context)
    if (writeContext?.kind === 'type') return null
    if (writeContext?.kind === 'columns') {
      const options = physicalColumns(writeContext.table).filter(c => !writeContext.used.some(used => sqlIdentifierMatches(used, c.label, engine)) && c.label.toLowerCase().startsWith(writeContext.prefix.toLowerCase()))
      return { from: writeContext.from, to: writeContext.to, options, filter: false }
    }
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
      const empty: Scope = { ctes: new Map(inherited), relations: new Map(outer), output: [], childOuter:new Map(outer),locals:new Map(),context:sqlColumnContext([],state,at??pos) }
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
      const hasSet=tokens.some(n=>['union','intersect','except'].includes(word(n)))
      tokens = tokens.slice(branchStart, branchEnd)
      const context=sqlColumnContext(tokens,state,at??pos)
      const compoundOrder=at!==undefined&&hasSet&&context.clause==='order'
      const relations = empty.relations, locals=empty.locals
      let childOuter:Bindings|undefined, argumentScope:Bindings|undefined,conditionScope:Bindings|undefined
      let group=new Map(outer),joinLeft:Bindings=new Map(),joinRight:Binding|undefined,using:Completion[]|undefined
      const from = tokens.findIndex(n => word(n) === 'from')
      const hint=(node?:SyntaxNode)=>sqlServer&&node?.name==='Parens'&&tableHints.has(word(children(node)[0]))
      if (from >= 0) {
        let expecting = true, lateral=false
        for (let i = from + 1; i < tokens.length; i++) {
          const token = tokens[i], value = word(token)
          if (stops.has(value)) break
          if (value === 'join' || value === ',' || value === 'apply'&&supportsApply) {
            if(value===',')group=new Map(outer)
            joinLeft=new Map([...group].filter(([name])=>locals.has(name)))
            expecting = true;lateral=value==='apply';continue
          }
          if(token.from===context.from&&(value==='on'||value==='using')) {
            conditionScope=new Map(group);childOuter=conditionScope
            if(value==='using'&&joinLeft.size===1&&joinRight) {
              const left=[...joinLeft.values()][0].columns
              using=joinRight.columns.filter(c=>left.some(l=>sqlIdentifierMatches({name:l.label,quoted:true},c.label,engine)))
            }
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
            const names=children(tokens[++i]);budget-=names.length
            const renamed=names.flatMap(n=>id(n)?[projected(id(n)!)]:[])
            if(renamed.length)cols=cols.length&&renamed.length>cols.length?[]:[...renamed,...cols.slice(renamed.length)]
          }
          const binding = alias ?? names.at(-1)
          if (binding) {
            const qualifier=(alias?[alias]:names).map(n=>n.quoted?completionIdentifier(n.name,engine):n.name).join('.')
            const value={id:binding,columns:locals.has(key(binding))?[]:cols,qualifier}
            locals.set(key(binding),value);relations.set(key(binding),value);group.set(key(binding),value);joinRight=value
          }
          lateral=false
        }
      }
      const select = tokens.findIndex(n => word(n) === 'select')
      const output: Completion[] = []
      const appendOutput=(values:Completion[])=>{
        budget-=values.length
        if(budget>=0)output.push(...values)
      }
      if (select >= 0) {
        const end=tokens.findIndex((n,i)=>i>select&&(word(n)==='from'||stops.has(word(n))))
        const projection = tokens.slice(select + 1, end < 0 ? tokens.length : end)
        let part: SyntaxNode[] = []
        const emit = () => {
          if (['distinct', 'all'].includes(word(part[0]))) part = part.slice(1)
          const as = part.findIndex(n => word(n) === 'as')
          const alias = as >= 0 ? id(part[as + 1]) : undefined
          if (alias) output.push(projected(alias))
          else if (part.length === 1 && text(part[0]) === '*') for (const binding of locals.values()) appendOutput(binding.columns)
          else if (part.length === 1 && path(part[0]).length && !text(part[0]).trimEnd().endsWith('.')) output.push(projected(path(part[0]).at(-1)!))
          else if (part.length && /\.\s*\*$/.test(state.sliceDoc(part[0].from, part.at(-1)!.to))) {
            const owner = path(part[0])[0]; if (owner) appendOutput(relations.get(key(owner))?.columns ?? [])
          }
          part = []
        }
        for (const token of projection) { if (word(token) === ',') emit(); else part.push(token) }
        emit()
      }
      if(argumentScope){context.column=context.expression;context.clause='where'}
      const visible=argumentScope??conditionScope??relations
      return { ctes, relations:compoundOrder?new Map():visible,
        output:compoundOrder?analyze(node,inherited,depth+1,undefined,outer).output:output,
        childOuter:childOuter??new Map(relations),locals:argumentScope?new Map():locals,context,using,compoundOrder }
    }
    let scope: Scope = { relations: new Map(), ctes: new Map(), output: [],childOuter:new Map(),locals:new Map(),context:sqlColumnContext([],state,pos) }
    for (const ancestor of ancestors) {
      scope = analyze(ancestor, scope.ctes, 0, pos,scope.childOuter)
      if(budget<0)break
    }
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
    if(scope.context.clause==='other')return base // Preserve existing DML behavior.
    // Never borrow the library's statement-wide column pool after doing a
    // query-block analysis. Metadata navigation remains available separately.
    const metadata=base?.options.filter(c=>c.type!=='property')??[]
    if(scope.context.clause==='table')metadata.push(...[...scope.ctes.values()].map(c=>({...projected(c.id),type:'type'})))
    const current=id(leaf)&&leaf.from<pos&&leaf.to>=pos?leaf:undefined
    const quote=current?.name==='QuotedIdentifier'?text(current)[0]:undefined
    const close=quote==='['?']':quote
    const field=(c:Completion)=>quote?quote+c.label.split(close!).join(close!+close!)+close:typeof c.apply==='string'?c.apply:completionIdentifier(c.label,engine)
    const unique=(values:Completion[])=>{
      const counts=new Map<string,number>()
      for(const c of values){const k=key({name:c.label,quoted:true});counts.set(k,(counts.get(k)??0)+1)}
      return values.filter(c=>counts.get(key({name:c.label,quoted:true}))===1)
    }
    const columns:Completion[]=[]
    if(scope.context.column) {
      if(scope.context.clause==='using')columns.push(...unique(scope.using??[]).map(c=>({...c,apply:field(c)})))
      else for(const [name,binding] of scope.relations) {
        const qualified=scope.relations.size>1||!scope.locals.has(name)
        for(const c of unique(binding.columns))columns.push({...c,
          label:c.label,displayLabel:qualified?`${binding.id.name}.${c.label}`:undefined,
          apply:qualified?`${binding.qualifier??String(projected(binding.id).apply)}.${field(c)}`:field(c),boost:90})
      }
      const clause=scope.context.clause
      const aliasClause=clause==='order'||clause==='group'&&[dialectFor('postgres'),dialectFor('mysql'),dialectFor('mariadb'),dialectFor('sqlite')].includes(dialect)
        ||clause==='having'&&(['mysql','mariadb','sqlite'].some(e=>dialect===dialectFor(e))||engine==='duckdb')
        ||clause==='qualify'&&engine==='duckdb'
      if(aliasClause&&(scope.context.standalone||clause==='having'||clause==='qualify')) {
        const aliases=unique(scope.output).map(c=>({...c,apply:field(c),boost:clause==='order'?99:80}))
        const merged=clause==='order'?[...aliases,...columns]:[...columns,...aliases]
        const seen=new Set<string>()
        columns.splice(0,columns.length,...merged.filter(c=>{const k=key({name:c.displayLabel??c.label,quoted:true});if(seen.has(k))return false;seen.add(k);return true}))
      }
    }
    if(!current&&!context.explicit&&!base)return null
    const options=[...columns,...metadata]
    if(quote) {
      const prefix=state.sliceDoc(current!.from+1,pos).split(close!+close!).join(close!).toLowerCase()
      return {from:current!.from,to:current!.to,filter:false,options:options.filter(c=>c.label.toLowerCase().includes(prefix))}
    }
    return {from:current?.from??base?.from??pos,to:current?.to??base?.to,options}
  }
}
