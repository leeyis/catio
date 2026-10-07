import type {EditorState} from '@codemirror/state'
import {ensureSyntaxTree} from '@codemirror/language'
import type {SyntaxNode} from '@lezer/common'
import {dialectFor} from './sqlDialect'
import {sqlIdentifierKey,sqlIdentifierMatches,sqlIdentifierSearch,type SqlIdentifier} from './sqlIdentifiers'
import {sqlColumnIssues} from './sqlColumnDiagnostics'

export type SqlDiagnosticCode = 'unclosedString'|'unclosedIdentifier'|'unclosedComment'|'unclosedParen'|'unexpectedClose'|'unknownTable'|'unknownColumn'|'ambiguousColumn'|'confusablePunctuation'|'limited'|'notReady'|'referenceSkipped'
export interface SqlIssue {
  from:number; to:number; severity:'error'|'warning'|'info'; code:SqlDiagnosticCode
  values?:{name?:string;namespace?:string;replacement?:string;sources?:string}
}
export interface SqlDiagnosticNamespace {
  name:string; tables:{name:string}[]; views:{name:string}[]
  status?:'loaded'|'unloaded'|'loading'|'error'; error?:string; truncated?:boolean
}
export interface SqlDiagnosticSchema {
  /** Legacy unqualified catalog. Empty means unavailable, not a complete empty namespace. */
  tables?:string[]
  namespaces?:SqlDiagnosticNamespace[]
  defaultSchema?:string
  /** Complete, current per-namespace catalogs only. Missing is unknown, not empty. */
  columnCatalogs?:Record<string,Record<string,readonly string[]>>
}
export const SQL_DIAGNOSTIC_MAX_CHARS=200_000
const MAX_NODES=8_000,MAX_ISSUES=100
const punctuationReplacements:Record<string,string>={'；':';','，':',','（':'(','）':')','＝':'='}
const identifiers=new Set(['Identifier','QuotedIdentifier','Keyword','Builtin','Type'])
const stops=new Set('where group having order limit offset fetch returning union intersect except qualify window for'.split(' '))
const modifiers=new Set('lateral only left right full inner outer cross natural'.split(' '))
interface Token { node:SyntaxNode; from:number; to:number; kind:string; raw:string; id?:SqlIdentifier }
export const diagnosticNotice=(code:SqlDiagnosticCode,length:number):SqlIssue=>({from:0,to:Math.min(1,length),severity:'info',code})

/** Local delimiters and evidence-backed catalog references only. This is NOT
 * server validation, type/derived-column inference, an execution gate, or a privilege check.
 * The live path shares the editor's dialect and bounded incremental parse context.
 */
export function sqlIssuesAt(state:EditorState,schema:SqlDiagnosticSchema,engine?:string,checkReferences=true):SqlIssue[] {
  if(state.doc.length>SQL_DIAGNOSTIC_MAX_CHARS)return [diagnosticNotice('limited',state.doc.length)]
  const tree=ensureSyntaxTree(state,state.doc.length,20)
  if(!tree||tree.length<state.doc.length)return [diagnosticNotice('notReady',state.doc.length)]
  const text=(n:{from:number;to:number})=>state.sliceDoc(n.from,n.to)
  const issue=(code:SqlDiagnosticCode,from:number,to:number):SqlIssue=>({code,from,to,severity:'error'})
  const syntax:SqlIssue[]=[],parens:number[]=[],opaque:Token[]=[]
  let visited=0,limited=false,unsupported=false
  const cursor=tree.cursor()
  do {
    if(++visited>MAX_NODES)return [diagnosticNotice('limited',state.doc.length)]
    const kind=cursor.name
    // Diagnose only standalone punctuation in parser error nodes. Do not scan
    // literals/comments/quoted names, or rewrite opaque Unicode identifiers.
    if(cursor.type.isError) {
      const raw=text(cursor)
      if(/^[；，（）＝]+$/.test(raw))for(let i=0;i<raw.length&&syntax.length<MAX_ISSUES;i++) {
        syntax.push({code:'confusablePunctuation',from:cursor.from+i,to:cursor.from+i+1,severity:'warning',values:{name:raw[i],replacement:punctuationReplacements[raw[i]]}})
      }
    }
    const hidden=['String','QuotedIdentifier','LineComment','BlockComment'].includes(kind)
    const raw=hidden?text(cursor):''
    if(hidden) {
      const previous=opaque.at(-1)
      // Lezer splits doubled quote escapes into touching nodes; preserve the
      // logical literal/identifier span, including its true opening delimiter.
      const quote=kind==='QuotedIdentifier'?raw[0]:raw.match(/^(?:[eEnNbBxX]|[uU]&)?(['"])/)?.[1]
      const previousQuote=previous?.kind==='QuotedIdentifier'?previous.raw[0]:previous?.raw.match(/^(?:[eEnNbBxX]|[uU]&)?(['"])/)?.[1]
      if(previous&&previous.kind===kind&&previous.to===cursor.from&&quote&&quote!=='['&&quote===previousQuote&&raw[0]===quote) {
        previous.to=cursor.to;previous.raw+=raw
      } else opaque.push({node:cursor.node,from:cursor.from,to:cursor.to,kind,raw})
    } else if(kind==='(')parens.push(cursor.from)
    else if(kind===')') {
      if(parens.length)parens.pop()
      else syntax.push(issue('unexpectedClose',cursor.from,cursor.to))
    }
    if(!cursor.next(!hidden))break
  }while(true)
  for(const token of opaque) {
    const raw=token.raw
    if(token.kind==='LineComment')continue
    if(token.kind==='BlockComment') {
      // The bundled CST supports nested comments. Only known nested-comment
      // engines can be checked that way; do not invent Oracle/MySQL errors.
      const nested=dialectFor(engine)===dialectFor('postgres')||dialectFor(engine)===dialectFor('sqlserver')||engine==='h2'
      let depth=0
      for(let i=0;i<raw.length-1;i++) {
        if(raw.slice(i,i+2)==='/*'){if(!nested&&depth>0)unsupported=true;depth++;i++}
        else if(raw.slice(i,i+2)==='*/'){depth--;i++}
      }
      if(!raw.includes('*/')||(nested&&depth>0))syntax.push(issue('unclosedComment',token.from,token.to))
      continue
    }
    const dollar=raw.match(/^\$(?:[\p{L}_][\p{L}\p{N}_]*|)\$/u)?.[0]
    const q=raw.match(/^(?:n)?q'(.)/i)
    let closed=false
    if(token.kind==='String'&&dollar)closed=raw.length>=dollar.length*2&&raw.endsWith(dollar)
    else if(token.kind==='String'&&q) {
      const close:Record<string,string>={'[':']','(':')','{':'}','<':'>'}
      closed=raw.length>=q[0].length+2&&raw.endsWith((close[q[1]]??q[1])+"'")
    } else {
      const start=token.kind==='QuotedIdentifier'?0:raw.search(/['"]/)
      if(start<0)continue // A provider-specific literal cannot be validated by guessing.
      const quote=raw[start]==='['?']':raw[start]
      const escapes=token.kind==='String'&&(!!dialectFor(engine).spec.backslashEscapes||/^e'/i.test(raw))
      for(let i=start+1;i<raw.length;i++) {
        if(escapes&&raw[i]==='\\'){i++;continue}
        if(raw[i]!==quote)continue
        if(raw[i+1]===quote){i++;continue}
        closed=i===raw.length-1;break
      }
    }
    if(!closed)syntax.push(issue(token.kind==='QuotedIdentifier'?'unclosedIdentifier':'unclosedString',token.from,token.to))
  }
  if(parens.length)syntax.push(issue('unclosedParen',parens.at(-1)!,parens.at(-1)!+1))
  if(syntax.length)return syntax.sort((a,b)=>a.from-b.from).slice(0,MAX_ISSUES)
  if(!checkReferences)return []

  let work=MAX_NODES
  const cache=new Map<number,Token[]>()
  const children=(node:SyntaxNode):Token[]=>{
    const cached=cache.get(node.from);if(cached&&node.name!=='Script')return cached
    const out:Token[]=[]
    const add=(n:SyntaxNode)=>{
      if(--work<0){limited=true;return}
      if(['LineComment','BlockComment','(',')',';'].includes(n.name))return
      if(n.name==='CompositeIdentifier'){for(let c=n.firstChild;c;c=c.nextSibling)add(c);return}
      const raw=n.name==='Parens'?'':text(n),previous=out.at(-1)
      if(n.name==='QuotedIdentifier'&&previous?.kind===n.name&&previous.to===n.from&&raw[0]!=='['&&previous.raw[0]===raw[0]) {
        previous.to=n.to;previous.raw+=raw
        previous.id={quoted:true,name:previous.raw.slice(1,-1).split(raw[0]+raw[0]).join(raw[0])};return
      }
      const quoted=n.name==='QuotedIdentifier',close=raw[0]==='['?']':raw[0]
      out.push({node:n,kind:n.name,from:n.from,to:n.to,raw,id:identifiers.has(n.name)?{quoted,name:quoted?raw.slice(1,-1).split(close+close).join(close):raw}:undefined})
    }
    for(let n=node.firstChild;n;n=n.nextSibling){add(n);if(limited)break}
    if(node.name!=='Script')cache.set(node.from,out)
    return out
  }
  const word=(n?:Token)=>n?.kind==='Keyword'?n.raw.toLowerCase():''
  const isQuery=(tokens:Token[])=>['select','with'].includes(word(tokens[0]))
  const key=(name:SqlIdentifier)=>sqlIdentifierKey(name,engine)
  const results:SqlIssue[]=[]
  const roots:SyntaxNode[]=[]
  for(let n=tree.topNode.firstChild;n;n=n.nextSibling)if(n.name==='Statement')roots.push(n)
  // Catalog names cannot prove validity after session/DDL changes in the same
  // script, or inside unsupported procedure bodies. Delimiter checks still ran.
  if(roots.some(n=>!isQuery(children(n))))unsupported=true
  if(limited)return [diagnosticNotice('limited',state.doc.length)]
  if(unsupported)return [diagnosticNotice('referenceSkipped',state.doc.length)]

  const namespaces=schema.namespaces??[]
  if(namespaces.length>256)return [diagnosticNotice('limited',state.doc.length)]
  const indexes=new Map<SqlDiagnosticNamespace,{exact:Set<string>;folded:Set<string>}>()
  let catalogBudget=20_000
  const absent=(names:SqlIdentifier[]):boolean=>{
    if(!names.length||names.length>2||names.some(n=>!n.quoted&&/^[#@]/.test(n.name)))return false
    const dialect=dialectFor(engine)
    if(names.length===1&&(engine==='h2'||['mysql','mariadb','oracle'].some(id=>dialect===dialectFor(id)))&&sqlIdentifierMatches(names[0],'DUAL',engine))return false
    if(!schema.namespaces) {
      return names.length===1&&!!schema.tables?.length&&!schema.tables.some(stored=>sqlIdentifierMatches(names[0],stored,engine))
    }
    const candidates=names.length===2?namespaces.filter(ns=>sqlIdentifierMatches(names[0],ns.name,engine)):namespaces.filter(ns=>ns.name===schema.defaultSchema)
    if(candidates.length!==1)return false
    const ns=candidates[0]
    if((ns.status&&ns.status!=='loaded')||ns.error||ns.truncated)return false
    let index=indexes.get(ns)
    if(!index) {
      catalogBudget-=ns.tables.length+ns.views.length
      if(catalogBudget<0){limited=true;return false}
      const values=[...ns.tables,...ns.views].map(t=>t.name)
      index={exact:new Set(values),folded:new Set(values.map(value=>value.toLowerCase()))};indexes.set(ns,index)
    }
    const {key:lookup,foldStored}=sqlIdentifierSearch(names.at(-1)!,engine)
    return !(foldStored?index.folded:index.exact).has(lookup)
  }
  const readPath=(tokens:Token[],at:number)=>{
    const first=tokens[at],names:SqlIdentifier[]=[]
    if(!first?.id)return null
    names.push(first.id)
    while(tokens[at+1]?.raw==='.') {
      if(!tokens[at+2]?.id)return null
      names.push(tokens[at+2].id!);at+=2
    }
    return {names,last:at,from:first.from,to:tokens[at].to}
  }
  const visit=(node:SyntaxNode,inherited:Set<string>,depth=0):void=>{
    if(limited)return
    if(depth>12||--work<0){limited=true;return}
    const all=children(node)
    if(!isQuery(all)) {
      for(const t of all)if(t.kind==='Parens')visit(t.node,inherited,depth+1)
      return
    }
    const ctes=new Set(inherited),bodies=new Set<number>()
    let start=0
    if(word(all[0])==='with') {
      const recursive=word(all[1])==='recursive'
      const allVisible=recursive||dialectFor(engine)===dialectFor('sqlite')
      const implicitSelf=dialectFor(engine)===dialectFor('sqlserver')||dialectFor(engine)===dialectFor('oracle')
      start=recursive?2:1
      const definitions:{id:SqlIdentifier;body:SyntaxNode}[]=[]
      while(start<all.length) {
        const name=all[start++]?.id;if(!name){unsupported=true;return}
        if(all[start]?.kind==='Parens')start++
        if(word(all[start++])!=='as'){unsupported=true;return}
        if(word(all[start])==='not')start++
        if(word(all[start])==='materialized')start++
        const body=all[start++];if(body?.kind!=='Parens'){unsupported=true;return}
        definitions.push({id:name,body:body.node});bodies.add(body.from)
        if(all[start]?.raw!==',')break
        start++
      }
      if(allVisible)for(const def of definitions)ctes.add(key(def.id))
      for(const def of definitions) {
        const visible=new Set(ctes);if(implicitSelf)visible.add(key(def.id))
        visit(def.body,visible,depth+1);ctes.add(key(def.id))
      }
    }
    const tokens=all.slice(start)
    let inFrom=false,expecting=false
    for(let i=0;i<tokens.length&&!limited;i++) {
      const token=tokens[i],kw=word(token)
      if(kw==='from'||kw==='join'||kw==='apply'){inFrom=true;expecting=true;continue}
      if(stops.has(kw)){inFrom=false;expecting=false;continue}
      if(inFrom&&token.raw===','){expecting=true;continue}
      if(!expecting||modifiers.has(kw))continue
      expecting=false
      const ref=readPath(tokens,i);if(!ref)continue
      i=ref.last
      if(tokens[i+1]?.kind==='Parens')continue // TVF, VALUES and explicit column lists are not table evidence.
      if(ref.names.length===1&&ctes.has(key(ref.names[0])))continue
      if(absent(ref.names)) {
        results.push({from:ref.from,to:ref.to,severity:'warning',code:'unknownTable',values:{name:text(ref),namespace:ref.names.length===2?ref.names[0].name:schema.defaultSchema??''}})
        if(results.length>=MAX_ISSUES)limited=true
      }
    }
    for(const token of tokens)if(token.kind==='Parens'&&!bodies.has(token.from))visit(token.node,ctes,depth+1)
  }
  // A generic grammar may represent valid vendor constructs as error nodes.
  // In those statements, skip object assertions instead of reporting fake tables.
  for(const root of roots) {
    let error=false
    tree.iterate({from:root.from,to:root.to,enter(n){if(n.type.isError)error=true}})
    if(error){unsupported=true;continue}
    visit(root,new Set())
  }
  if(limited)results.push(diagnosticNotice('limited',state.doc.length))
  else if(unsupported)results.push(diagnosticNotice('referenceSkipped',state.doc.length))
  else results.push(...sqlColumnIssues(state,tree,schema,engine))
  return results.slice(0,MAX_ISSUES)
}
