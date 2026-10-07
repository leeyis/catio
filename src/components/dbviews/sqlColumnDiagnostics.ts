import type {EditorState} from '@codemirror/state'
import type {SyntaxNode,Tree} from '@lezer/common'
import {CompletionContext} from '@codemirror/autocomplete'
import {scopedSchemaCompletion,type SqlColumnScope} from './sqlScopeCompletion'
import {sqlIdentifierKey,sqlIdentifierMatches,type SqlIdentifier} from './sqlIdentifiers'
import {dialectFor} from './sqlDialect'
import type {SqlDiagnosticSchema,SqlIssue} from './sqlDiagnosticAnalysis'

type Part={id:SqlIdentifier;node:SyntaxNode}
/** Non-executing, bounded checks against complete catalogs. Scope identities are
 * shared with completion, but absence is NEVER inferred from completion options.
 * Derived/CTE/function outputs deliberately stay unknown in this first path. */
export function sqlColumnIssues(state:EditorState,tree:Tree,schema:SqlDiagnosticSchema,engine?:string):SqlIssue[] {
  const catalogs=schema.columnCatalogs,namespaces=schema.namespaces
  if(!catalogs||!namespaces)return []
  const started=performance.now(),candidates:{node:SyntaxNode;parts:Part[]}[]=[]
  let visited=0,unsafeNames=false,mergedColumns=false,limited=false
  const raw=(node:SyntaxNode)=>state.sliceDoc(node.from,node.to)
  const word=(node:SyntaxNode|null)=>node&&node.to-node.from<=64?raw(node).toLowerCase():''
  const adjacent=(node:SyntaxNode,forward:boolean)=>{
    let next=forward?node.nextSibling:node.prevSibling
    while(next&&['LineComment','BlockComment'].includes(next.name))next=forward?next.nextSibling:next.prevSibling
    return next
  }
  const identifier=(node:SyntaxNode):SqlIdentifier|undefined=>{
    if(!['Identifier','QuotedIdentifier','Keyword','Builtin','Type'].includes(node.name))return
    const value=raw(node),quoted=node.name==='QuotedIdentifier',close=value[0]==='['?']':value[0]
    return {name:quoted?value.slice(1,-1).split(close+close).join(close):value,quoted}
  }
  const collect=(node:SyntaxNode)=>{
    // Lezer can split an escaped quoted name across a composite and its next
    // sibling. Until the shared scope path merges it, do not diagnose a fragment.
    if(node.nextSibling?.name==='QuotedIdentifier'&&node.to===node.nextSibling.from){unsafeNames=true;return}
    if(adjacent(node,true)?.name==='Parens')return // Function/type names, not arguments.
    if(['::',':','collate','over'].includes(word(adjacent(node,false))))return
    const parts:Part[]=[]
    if(node.name==='CompositeIdentifier') {
      let wantId=true
      for(let child=node.firstChild;child;child=child.nextSibling) {
        if(['LineComment','BlockComment'].includes(child.name))continue
        if(wantId){const id=identifier(child);if(!id)return;parts.push({id,node:child})}
        else if(child.name!=='.'){if(child.name==='QuotedIdentifier')unsafeNames=true;return}
        wantId=!wantId
      }
      if(wantId||parts.length>3)return
    } else {
      if(node.name==='QuotedIdentifier'&&[node.prevSibling,node.nextSibling].some(n=>n?.name==='QuotedIdentifier'&&(n.to===node.from||n.from===node.to))){unsafeNames=true;return}
      const id=identifier(node);if(!id)return
      parts.push({id,node})
    }
    // Date-part identifiers are grammar arguments, not physical column names.
    const parent=node.parent
    if(parent?.name==='Parens'&&['extract','datepart','dateadd','datediff'].includes(word(parent.prevSibling))) {
      let first=parent.firstChild
      while(first&&['(','LineComment','BlockComment'].includes(first.name))first=first.nextSibling
      if(first?.from===node.from)return
    }
    if(candidates.length>=64){limited=true;return}
    candidates.push({node,parts})
  }
  tree.iterate({enter(ref){
    if(limited)return false
    if(++visited>8000){limited=true;return false}
    if(['String','LineComment','BlockComment','QuotedIdentifier'].includes(ref.name)) {
      if(ref.name==='QuotedIdentifier')collect(ref.node)
      return false
    }
    if(ref.name==='Keyword'&&['using','natural'].includes(word(ref.node)))mergedColumns=true
    if(ref.name==='CompositeIdentifier'){collect(ref.node);return false}
    // lang-sql tokenizes PostgreSQL's non-reserved ID as Keyword. Do not
    // reinterpret every grammar keyword as a field (SELECT/WHERE etc.).
    if(ref.name==='Identifier'||ref.name==='Keyword'&&word(ref.node)==='id')collect(ref.node)
  }})
  if(unsafeNames||!candidates.length&&!limited)return []
  const notice=():SqlIssue=>({from:0,to:Math.min(1,state.doc.length),code:'limited',severity:'info'})
  if(limited)return [notice()]
  const resolve=(path:readonly SqlIdentifier[]|undefined):readonly string[]|undefined=>{
    if(!path?.length||path.length>2||path.some(id=>!id.quoted&&/^[#@]/.test(id.name)))return
    const matches=path.length===1?namespaces.filter(ns=>ns.name===schema.defaultSchema):namespaces.filter(ns=>sqlIdentifierMatches(path[0],ns.name,engine))
    if(matches.length!==1)return
    const ns=matches[0]
    if(ns.status&&ns.status!=='loaded'||ns.error||ns.truncated||!Object.prototype.hasOwnProperty.call(catalogs,ns.name))return
    const tables=[...ns.tables,...ns.views].filter(table=>sqlIdentifierMatches(path.at(-1)!,table.name,engine))
    if(tables.length!==1||!Object.prototype.hasOwnProperty.call(catalogs[ns.name],tables[0].name))return
    const columns=catalogs[ns.name][tables[0].name]
    return columns.length<=4000?columns:undefined
  }
  const pseudo=(id:SqlIdentifier)=>{
    if(!id.quoted&&/^[#@$]/.test(id.name))return true
    const name=id.name.toLowerCase(),dialect=dialectFor(engine)
    if((dialect===dialectFor('sqlite')||engine==='duckdb')&&['rowid','oid','_rowid_'].includes(name))return true
    if(!id.quoted&&dialect===dialectFor('oracle')&&['rowid','rownum','ora_rowscn'].includes(name))return true
    return !id.quoted&&dialect===dialectFor('postgres')&&engine!=='duckdb'&&['ctid','tableoid','xmin','xmax','cmin','cmax'].includes(name)
  }
  // Resolve only lexical identities, without constructing a completion catalog
  // for every table. Inferred/omitted output is not evidence of column absence.
  // Physical columns always come from resolve() above.
  let scopeValue:SqlColumnScope|undefined
  const inspectSource=scopedSchemaCompletion(Object.create(null),schema.defaultSchema,engine,scope=>{scopeValue=scope})
  const inspect=(pos:number):SqlColumnScope|undefined=>{
    scopeValue=undefined // A budget/unready return must not reuse the previous reference's scope.
    inspectSource(new CompletionContext(state,pos,true))
    return scopeValue
  }
  const issues:SqlIssue[]=[]
  for(const {node,parts} of candidates) {
    if(performance.now()-started>30){issues.push(notice());break}
    const last=parts.at(-1)!
    if(pseudo(last.id))continue
    const scope=inspect(node.to)
    if(!scope?.column||scope.compoundOrder)continue
    let relations:SqlColumnScope['relations']
    if(parts.length>1) {
      const qualifiers=parts.slice(0,-1).map(p=>p.id)
      relations=scope.relations.filter(binding=>qualifiers.length===1
        ?sqlIdentifierKey(qualifiers[0],engine)===sqlIdentifierKey(binding.id,engine)
        :binding.qualification?.length===qualifiers.length&&qualifiers.every((id,i)=>sqlIdentifierKey(id,engine)===sqlIdentifierKey(binding.qualification![i],engine)))
      if(relations.length!==1)continue
    } else {
      // Projection aliases, merged USING/NATURAL outputs, and nearest-outer
      // bare-column precedence need more evidence than a flattened binding map.
      if(!['select','where','on'].includes(scope.clause)||mergedColumns||scope.relations.some(b=>!b.local))continue
      if(engine==='duckdb'||dialectFor(engine)===dialectFor('sqlite')&&scope.clause!=='select')continue
      if(scope.relations.some(b=>sqlIdentifierKey(b.id,engine)===sqlIdentifierKey(last.id,engine)))continue // Whole-row references.
      relations=scope.relations
    }
    if(!relations.length)continue
    const columns=relations.map(binding=>resolve(binding.physical))
    if(columns.some(value=>value===undefined))continue
    const matches=relations.filter((_,i)=>columns[i]!.some(name=>sqlIdentifierMatches(last.id,name,engine)))
    if(matches.length===1)continue
    issues.push({from:last.node.from,to:last.node.to,severity:'warning',code:matches.length?'ambiguousColumn':'unknownColumn',values:{name:last.id.name,sources:(matches.length?matches:relations).map(b=>b.id.name).join(', ')}})
    if(issues.length>=32){issues.push(notice());break}
  }
  return issues
}
