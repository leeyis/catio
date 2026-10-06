import type {EditorState} from '@codemirror/state'
import type {SyntaxNode} from '@lezer/common'

export type ColumnClause = 'select'|'where'|'on'|'using'|'group'|'order'|'having'|'qualify'|'table'|'none'|'other'
/** Query-level clause and local expression slot. Nested function grammar (e.g.
 * EXTRACT ... FROM) never changes the enclosing SELECT's table/column context. */
export function sqlColumnContext(tokens:readonly SyntaxNode[],state:EditorState,pos:number) {
  const word=(n?:SyntaxNode)=>n&&n.to-n.from<=32?state.sliceDoc(n.from,n.to).toLowerCase():''
  let clause:ColumnClause=tokens.some(n=>word(n)==='select')?'none':'other'
  let from=-1,itemStart=0,table=false,pending:'group'|'order'|undefined
  for(let i=0;i<tokens.length&&tokens[i].from<pos;i++) {
    const n=tokens[i],v=word(n)
    if(n.to>pos)break
    let next:ColumnClause|undefined
    if(v==='select'){next='select';table=false}
    else if(v==='from'||table&&(['join','apply'].includes(v)||v===','&&['table','on','using'].includes(clause))){next='table';table=true}
    else if(table&&(v==='on'||v==='using'))next=v
    else if(['where','having','qualify'].includes(v))next=v as ColumnClause
    else if(v==='group'||v==='order'){pending=v;next='none'}
    else if(v==='by'&&pending){next=pending;pending=undefined}
    else if(['limit','offset','fetch','returning','window','for','into'].includes(v))next='none'
    if(next!==undefined){clause=next;from=n.from;itemStart=i+1}
    else if(v===',')itemStart=i+1
  }
  // Descend only through the expression containing the cursor, not subqueries.
  let local=tokens.slice(itemStart),nested=false
  for(let depth=0;depth<12;depth++) {
    const parens=local.find(n=>n.name==='Parens'&&n.from<pos&&pos<n.to)
    if(!parens)break
    local=[];nested=true
    for(let n=parens.firstChild;n;n=n.nextSibling)if(!['(',')','LineComment','BlockComment'].includes(n.name))local.push(n)
  }
  const current=local.find(n=>n.from<pos&&n.to>=pos)
  const before=local.filter(n=>n.to<=(current?.from??pos))
  const last=before.at(-1),v=word(last)
  const operators=new Set('distinct all case when then else not and or in between is like ilike similar to escape by partition filter over from'.split(' '))
  const ended=last&&(['Identifier','QuotedIdentifier','CompositeIdentifier','Parens','Number','String','Bool','Null','Builtin','Type'].includes(last.name)||last.name==='Keyword'&&!operators.has(v))
  const expression=v!=='as'&&!ended&&!(v==='*'&&before.length===1)
  const column=['select','where','on','using','group','order','having','qualify'].includes(clause)&&expression
  return {clause,from,column,expression,standalone:!nested&&before.length===0}
}
