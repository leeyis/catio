import {useTranslation} from 'react-i18next'
import {Icon} from '../Icon'
import type {QueryResult} from '../../services/types'
import {stripAiSqlComments,classifyAiSqlExecution} from '../../services/aiSqlExecutionPolicy'

/** A driver's changes counter may survive DDL/session commands (notably SQLite).
 * Show row impact only for a single DML-shaped receipt; never invent a DDL row count. */
export function receiptRowImpact(sql:string,result?:QueryResult):number|undefined {
  return result?.rowsAffected!=null&&/^(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/i.test(stripAiSqlComments(sql).trimStart())&&!classifyAiSqlExecution(sql).reasons.includes('multi_statement')?result.rowsAffected:undefined
}

export interface QueryStatementReceipt {
  source?:{document:string;from:number;to:number}
  querySessionId?:string
  sql:string
  defaultNamespace?:string
  result?:QueryResult
  error?:string
  /** Observed client await time, including transport. Not server execution cost. */
  durationMs?:number
}
export function QueryExecutionLog({entries,running,error,total,document,onLocate}:{
  entries:readonly QueryStatementReceipt[];running:boolean;error:string|null;total:number;document:string;
  onLocate:(source:NonNullable<QueryStatementReceipt['source']>)=>void
}) {
  const {t}=useTranslation()
  return <section className="db-output-log scrollon" data-testid="sql-execution-log" aria-label={t('dbviews.workspace.messages')}>
    <p className="db-output-log-note">{t('dbviews.workspace.receiptHint')}</p>
    {!entries.length&&!running&&!error&&<div className="db-output-empty"><Icon name="terminal" size={25}/><strong>{t('dbviews.workspace.noReceipts')}</strong></div>}
    {entries.map((entry,index)=><article className="db-receipt" key={index}>
      <div className="db-receipt-head"><Icon name={entry.error?'alert-triangle':'check'} size={13} style={{color:entry.error?'var(--danger-fg)':'var(--signal-green)'}}/>
        <strong>{t('dbviews.statementNumber',{number:index+1})}</strong>
        <span>{t(entry.error?'dbviews.workspace.failed':'dbviews.workspace.received')}</span>
        {entry.durationMs!==undefined&&<span className="mono" title={t('dbviews.workspace.roundTrip')}>{entry.durationMs.toLocaleString()} ms</span>}
        {entry.result&&<span>{entry.result.rowsAffected!=null?(receiptRowImpact(entry.sql,entry.result)!==undefined?t('dbviews.rowsAffected',{count:receiptRowImpact(entry.sql,entry.result)}):t('dbviews.workspace.commandReceipt')):`${t('dbviews.workspace.returned')}: ${entry.result.rows.length}${entry.result.truncated?'+':''}`}</span>}
        {entry.source&&<button className="btn btn-ghost sm" style={{marginLeft:'auto'}} disabled={entry.source.document!==document} onClick={()=>onLocate(entry.source!)}><Icon name="code" size={12}/>{t('dbviews.locateSqlSource')}</button>}
      </div>
      <pre className="mono">{entry.sql}</pre>
      {entry.error&&<div className="db-receipt-error">{entry.error}</div>}
    </article>)}
    {running&&<div className="row gap8" style={{color:'var(--text-tertiary)'}}><Icon name="loader" size={15}/>{t('dbviews.workspace.pendingReceipt')}</div>}
    {error&&!entries.some(e=>e.error===error)&&<div className="db-receipt-error" role="alert">{error}</div>}
    {!running&&total>entries.length&&<p className="db-output-log-note">{t('dbviews.workspace.notSent',{count:total-entries.length})}</p>}
  </section>
}
