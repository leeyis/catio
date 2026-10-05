import type { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'

export interface SqlExecutionTarget { from:number; to:number; sql:string; kind:'current'|'selection'|'all' }
export type SqlTargetResult = { target:SqlExecutionTarget; reason?:never } | { target:null; reason:'empty'|'notReady'|'unsupported'|'ambiguous' }

/** Execution boundaries come from the editor's dialect CST. Explicit selections
 * and scripts still go through the backend splitter; inference never widens scope. */
export function sqlExecutionTarget(state:EditorState,scope:'current'|'selection'|'all',plain=false):SqlTargetResult {
  const selection=state.selection.main
  if(scope==='selection'||(scope==='current'&&!selection.empty)) {
    const sql=state.sliceDoc(selection.from,selection.to)
    return !selection.empty&&sql.trim()?{target:{from:selection.from,to:selection.to,sql,kind:'selection'}}:{target:null,reason:'empty'}
  }
  if(scope==='all'||plain) {
    const sql=state.doc.toString()
    return sql.trim()?{target:{from:0,to:state.doc.length,sql,kind:'all'}}:{target:null,reason:'empty'}
  }
  if(state.doc.length>200_000)return {target:null,reason:'notReady'}
  const tree=ensureSyntaxTree(state,state.doc.length,20)
  if(!tree||tree.length<state.doc.length)return {target:null,reason:'notReady'}
  const caret=selection.head
  let chosen:typeof tree.topNode|null=null
  for(let node=tree.topNode.firstChild;node;node=node.nextSibling) {
    if(node.name!=='Statement')continue
    if(caret>=node.from&&caret<=node.to){chosen=node;break}
    if(caret<node.from&&state.doc.lineAt(caret).number===state.doc.lineAt(node.from).number){chosen=node;break}
    if(caret>node.to&&state.doc.lineAt(caret).number===state.doc.lineAt(node.to).number&&!state.sliceDoc(node.to,caret).trim())chosen=node
  }
  if(!chosen)return {target:null,reason:'empty'}

  // Inspect the entire bounded document, not only the chosen Statement: generic
  // CSTs split a trigger/BEGIN body at semicolons. Its interior must not execute
  // as a standalone write. Preserve newlines while masking literals/comments.
  const masked=state.doc.toString().split(''),cursor=tree.cursor()
  let nodes=0,invalid=false
  do {
    if(++nodes>8_000)return {target:null,reason:'notReady'}
    if(cursor.type.isError&&cursor.from<=chosen.to&&cursor.to>=chosen.from)invalid=true
    const comment=cursor.name.endsWith('Comment')
    if(comment&&caret>=cursor.from&&caret<cursor.to)return {target:null,reason:'empty'}
    const opaque=comment||cursor.name==='String'||cursor.name==='QuotedIdentifier'
    if(opaque)for(let i=cursor.from;i<cursor.to;i++)if(masked[i]!=='\n'&&masked[i]!=='\r')masked[i]=' '
    if(!cursor.next(!opaque))break
  }while(true)
  const text=masked.join('')
  if(/^\s*(?:DELIMITER\b|GO(?:\s+\d+)?\s*$)/im.test(text)
    ||/\bCREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:FUNCTION|PROCEDURE|PROC|TRIGGER|PACKAGE)\b/i.test(text)
    ||/(?:^|;)\s*(?:DECLARE\b|IF\b|WHILE\b|BEGIN\s+(?!(?:TRANSACTION|TRAN|WORK|DEFERRED|IMMEDIATE|EXCLUSIVE)\b)[^;])/i.test(text))return {target:null,reason:'unsupported'}
  if(invalid)return {target:null,reason:'ambiguous'}
  const target={from:chosen.from,to:chosen.to,sql:state.sliceDoc(chosen.from,chosen.to),kind:'current' as const}
  return target.sql.trim()?{target}:{target:null,reason:'empty'}
}
