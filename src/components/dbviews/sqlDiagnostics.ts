import {EditorState} from '@codemirror/state'
import type {Diagnostic} from '@codemirror/lint'
import type {EditorView} from '@codemirror/view'
import i18n from '../../i18n'
import {dialectFor} from './sqlDialect'
import {sqlIssuesAt,diagnosticNotice,SQL_DIAGNOSTIC_MAX_CHARS,type SqlIssue,type SqlDiagnosticSchema,type SqlDiagnosticCode} from './sqlDiagnosticAnalysis'
export type {SqlDiagnosticSchema} from './sqlDiagnosticAnalysis'

export interface SqlDiagnostic extends SqlIssue {
  startLine:number; startColumn:number; endLine:number; endColumn:number; message:string
}
type SqlDiagnosticTextKey=SqlDiagnosticCode|'replacePunctuation'
export interface SqlDiagnosticOptions {
  engine?:string
  checkReferences?:boolean
  translate?:(code:SqlDiagnosticTextKey,values?:SqlIssue['values'])=>string
}
const text=(code:SqlDiagnosticTextKey,values:SqlIssue['values'],options:SqlDiagnosticOptions)=>options.translate?.(code,values)??i18n.t('dbviews.sqlDiagnostics.'+code,values??{})
const message=(d:SqlIssue,options:SqlDiagnosticOptions)=>text(d.code,d.values,options)

/** Compatibility helper for non-editor callers. Live diagnostics must keep
 * namespace/loading identity instead of treating this flattened list as complete. */
export interface NamedSchema {schemas:{tables:{name:string}[];views:{name:string}[]}[]}
export function linterTableNames(connId:string|undefined,liveSchema:NamedSchema|null,demoSchema:NamedSchema):string[] {
  if(connId&&!liveSchema)return []
  return (liveSchema??demoSchema).schemas.flatMap(ns=>[...ns.tables,...ns.views].map(t=>t.name))
}

/** Pure-call adapter. The live editor below reuses its existing parser/state. */
export function sqlDiagnostics(sql:string,schema:SqlDiagnosticSchema,options:SqlDiagnosticOptions={}):SqlDiagnostic[] {
  if(sql.length>SQL_DIAGNOSTIC_MAX_CHARS) {
    const notice=diagnosticNotice('limited',sql.length)
    return [{...notice,message:message(notice,options),startLine:1,startColumn:1,endLine:1,endColumn:2}]
  }
  const state=EditorState.create({doc:sql,extensions:[dialectFor(options.engine).language]})
  return sqlIssuesAt(state,schema,options.engine,options.checkReferences).map(d=>{
    const from=state.doc.lineAt(d.from),to=state.doc.lineAt(d.to)
    return {...d,message:message(d,options),startLine:from.number,startColumn:d.from-from.from+1,endLine:to.number,endColumn:d.to-to.from+1}
  })
}

/** Catalog/locale changes install a fresh source but do not rebuild EditorView.
 * Codes, not translated text, control suppression while the user is typing. */
export function sqlLinter(getSchema:()=>SqlDiagnosticSchema,options:SqlDiagnosticOptions={}):(view:EditorView)=>Diagnostic[] {
  return view=>{
    const selection=view.state.selection.main,caret=selection.head
    return sqlIssuesAt(view.state,getSchema(),options.engine,options.checkReferences).filter(d=>{
      // Parser/catalog capability notices are not mistakes in the user's SQL.
      // Preserve them in the analysis API, but don't underline the first letter
      // or show an unactionable tooltip. No diagnostics is not a validation pass.
      if(d.severity==='info')return false
      if(!selection.empty)return true
      if((d.code.startsWith('unclosed')||d.code==='unknownTable'||d.code==='unknownColumn'||d.code==='ambiguousColumn')&&caret>=d.from&&caret<=d.to)return false
      if(d.code==='unclosedParen'&&view.state.doc.lineAt(caret).number===view.state.doc.lineAt(d.from).number)return false
      return true
    }).map((d):Diagnostic=>{
      const diagnostic:Diagnostic={from:d.from,to:d.to,severity:d.severity,message:message(d,options),source:'SQL'}
      const name=d.values?.name,replacement=d.values?.replacement
      if(d.code==='confusablePunctuation'&&name&&replacement)diagnostic.actions=[{
        name:text('replacePunctuation',d.values,options),
        apply(current,from,to){
          // CodeMirror maps the range while typing. Recheck the live syntax too:
          // an old repair must not rewrite text that has since become a literal.
          if(current.state.readOnly||current.state.sliceDoc(from,to)!==name)return
          if(!sqlIssuesAt(current.state,getSchema(),options.engine).some(issue=>issue.code===d.code&&issue.from===from&&issue.to===to&&issue.values?.name===name))return
          current.dispatch({changes:{from,to,insert:replacement},selection:{anchor:from+replacement.length},userEvent:'input'})
          current.focus()
        },
      }]
      return diagnostic
    })
  }
}
