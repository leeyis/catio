import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn } from '../atoms'
import { Icon } from '../Icon'
import { filterTables, toggleSelected, selectAllFiltered, clearFiltered, exportReady } from './databaseExport'
import { dbErrMsg } from '../../services/db'
import { useReportDatabaseWork } from '../../state/databaseDraftWork'
import { DatabaseFileFlow } from './DatabaseFileFlow'

export interface DatabaseExportRequest {
  selectedTables: string[] | undefined
  includeStructure: boolean
  includeData: boolean
  batchSize?: number
  rowLimit?: number
}
export type DatabaseExportOutcome = {kind:'saved'|'download';name:string} | {kind:'cancelled'}
export interface DatabaseExportDialogProps {
  schema: string
  connectionName?: string
  /** Connection identity isolates a previous target's review and callbacks. */
  connId?: string
  allTables: string[]
  onClose: () => void
  onExport: (req: DatabaseExportRequest) => Promise<DatabaseExportOutcome>
}
export function DatabaseExportDialog(props: DatabaseExportDialogProps) {
  return <DatabaseExportFlow key={JSON.stringify([props.connId,props.schema])} {...props}/>
}
function positiveOption(raw: string, max: number): number | undefined | null {
  if (!raw.trim()) return undefined
  const n = Number(raw)
  return /^\d+$/.test(raw.trim()) && Number.isSafeInteger(n) && n > 0 && n <= max ? n : null
}
function DatabaseExportFlow({schema, connectionName, allTables, onClose, onExport}: DatabaseExportDialogProps) {
  const {t} = useTranslation()
  const [selected,setSelected] = useState([...allTables]), [filter,setFilter] = useState('')
  const [includeStructure,setIncludeStructure] = useState(true), [includeData,setIncludeData] = useState(true)
  const [batchSize,setBatchSize] = useState(''), [rowLimit,setRowLimit] = useState('')
  const [step,setStep] = useState(0), [review,setReview] = useState<DatabaseExportRequest | null>(null)
  const [busy,setBusy] = useState(false), lock=useRef(false), generation=useRef(0)
  const [err,setErr] = useState<string | null>(null), [outcome,setOutcome] = useState<DatabaseExportOutcome | null>(null)
  useEffect(() => () => { generation.current++ }, [])
  useReportDatabaseWork('database-export',step === 1,busy)
  const filtered=useMemo(()=>filterTables(allTables,filter),[allTables,filter])
  const selectedSet=new Set(selected), chosen=allTables.filter(name=>selectedSet.has(name))
  const batch=positiveOption(batchSize,1000), limit=positiveOption(rowLimit,4294967295)
  const validNumbers=!includeData || (batch!==null && limit!==null)
  const ready=exportReady({selectedCount:chosen.length,includeStructure,includeData}) && validNumbers
  const target=[connectionName,schema].filter(Boolean).join(' · ')
  function close(){if(!lock.current)onClose()}
  function reviewExport(){
    if(!ready || lock.current)return
    // The final action uses this exact list, never an implicit "all" evaluated later.
    setReview({selectedTables:[...chosen],includeStructure,includeData,batchSize:includeData ? batch ?? undefined : undefined,rowLimit:includeData ? limit ?? undefined : undefined})
    setStep(1)
  }
  async function run(){
    if(lock.current || step!==1 || !review)return
    lock.current=true;setBusy(true);setStep(2);setErr(null)
    const token=++generation.current
    try {
      const result=await onExport(review)
      if(token!==generation.current)return
      if(!result || !['saved','download','cancelled'].includes(result.kind))throw new Error(t('dbflow.noReceipt'))
      setOutcome(result)
    }catch(error){if(token===generation.current)setErr(dbErrMsg(error))}
    finally{if(token===generation.current){lock.current=false;setBusy(false)}}
  }
  const check=(testId:string,on:boolean,toggle:()=>void,label:string)=><button className="db-flow-check" data-testid={testId} aria-pressed={on} onClick={toggle}><span className="db-flow-checkmark">{on&&<Icon name="check" size={10}/>}</span>{label}</button>
  return <DatabaseFileFlow title={t('dbexport.title')} target={target} steps={[t('dbflow.scope'),t('dbflow.review'),t('dbflow.receipt')]} step={step} busy={busy} onClose={close}
    footer={<>
      <Btn variant="ghost" disabled={busy} onClick={close}>{step===2?t('dbviews.close'):t('dbviews.cancel')}</Btn>
      {step===0&&<Btn variant="primary" testId="dbflow-next" disabled={!ready} onClick={reviewExport}>{t('dbflow.next')}</Btn>}
      {step===1&&<><Btn variant="secondary" testId="dbflow-back" onClick={()=>setStep(0)}>{t('dbflow.back')}</Btn><Btn variant="primary" icon="download" testId="dbexport-run" onClick={run}>{t('dbexport.export')}</Btn></>}
    </>}>
    {step===0&&<>
      <h3>{t('dbexport.tableSelection')} <small className="db-flow-muted">{t('dbexport.selectedCount',{selected:chosen.length,total:allTables.length})}</small></h3>
      <input data-testid="dbexport-filter" aria-label={t('dbexport.filterTables')} placeholder={t('dbexport.filterTables')} value={filter} onChange={e=>setFilter(e.target.value)}/>
      <div className="row gap8" style={{marginTop:8}}><Btn size="sm" variant="ghost" testId="dbexport-select-all" onClick={()=>setSelected(selectAllFiltered(allTables,chosen,filtered))}>{t('dbexport.selectAll')}</Btn><Btn size="sm" variant="ghost" testId="dbexport-clear" onClick={()=>setSelected(clearFiltered(chosen,filtered))}>{t('dbexport.clear')}</Btn></div>
      <p className="db-flow-muted">{t('dbflow.filteredSelection')}</p>
      <div className="db-flow-table-picker">{filtered.length===0?<p className="db-flow-muted">{t('dbexport.noTables')}</p>:filtered.map(name=><button key={name} data-testid={`dbexport-tbl:${name}`} aria-pressed={selectedSet.has(name)} onClick={()=>setSelected(toggleSelected(allTables,chosen,name))}><span className="db-flow-checkmark">{selectedSet.has(name)&&<Icon name="check" size={10}/>}</span><Icon name="table-2" size={13}/><span className="mono">{name}</span></button>)}</div>
      <section><h3>{t('dbexport.options')}</h3>{check('dbexport-opt-structure',includeStructure,()=>setIncludeStructure(v=>!v),t('dbexport.includeStructure'))}{check('dbexport-opt-data',includeData,()=>setIncludeData(v=>!v),t('dbexport.includeData'))}
        {includeStructure&&<p className="db-flow-notice">{t('dbflow.derivedDdl')}</p>}
        <div className="db-flow-fields"><label>{t('dbexport.batchSize')}<input data-testid="dbexport-batch" type="number" min={1} max={1000} step={1} disabled={!includeData} value={batchSize} onChange={e=>setBatchSize(e.target.value)} placeholder={t('dbexport.batchSizePlaceholder')}/></label><label>{t('dbexport.rowLimit')}<input data-testid="dbexport-rowlimit" type="number" min={1} max={4294967295} step={1} disabled={!includeData} value={rowLimit} onChange={e=>setRowLimit(e.target.value)} placeholder={t('dbexport.rowLimitPlaceholder')}/></label></div>
        {!validNumbers&&<p role="alert" className="db-flow-notice" data-danger="true">{t('dbflow.invalidLimits')}</p>}
      </section>
    </>}
    {step===1&&review&&<section data-testid="dbexport-review"><h3>{t('dbflow.review')}</h3><dl className="db-flow-summary"><dt>{t('dbviews.transferSource')}</dt><dd className="mono">{target}</dd><dt>{t('dbexport.tableSelection')}</dt><dd className="mono">{review.selectedTables?.join(', ')}</dd><dt>{t('dbexport.options')}</dt><dd>{[review.includeStructure?t('dbexport.includeStructure'):null,review.includeData?t('dbexport.includeData'):null].filter(Boolean).join(' · ')}</dd>
      {review.includeData&&<><dt>{t('dbexport.batchSize')}</dt><dd>{review.batchSize ?? t('dbflow.backendDefault')}</dd><dt>{t('dbexport.rowLimit')}</dt><dd>{review.rowLimit ?? t('dbflow.allRows')}</dd></>}
      <dt>{t('dbflow.format')}</dt><dd>SQL</dd></dl>
      {review.includeStructure&&<p className="db-flow-notice">{t('dbflow.derivedDdl')}</p>}
      <p className="db-flow-notice">{t('dbflow.exportBoundary')}</p>
    </section>}
    {step===2&&<section className="db-flow-receipt" data-testid="dbflow-receipt" data-error={!!err} aria-live="polite"><Icon name={busy?'loader':err?'alert-triangle':outcome?.kind==='cancelled'?'file':'circle-check'} size={28}/><h3>{busy?t('dbexport.exporting'):err?t('dbflow.exportUnconfirmed'):outcome?.kind==='cancelled'?t('dbflow.saveCancelled'):outcome?.kind==='download'?t('dbflow.downloadRequested'):t('dbflow.saved')}</h3>
      <p className="mono">{target}</p>{outcome&&outcome.kind!=='cancelled'&&<p className="mono">{outcome.name}</p>}
      {busy&&<p className="db-flow-notice">{t('dbflow.waitReceipt')}</p>}
      {err&&<p role="alert" className="db-flow-notice" data-danger="true">{t('dbexport.error',{message:err})}</p>}
      {outcome?.kind==='download'&&<p className="db-flow-notice">{t('dbflow.browserSaveHint')}</p>}
    </section>}
  </DatabaseFileFlow>
}
