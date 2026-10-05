import {useEffect,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {tableStructure,dbErrMsg,SCHEMA_INVALIDATED_EVENT} from '../../services/db'
import type {TableStructure} from '../../services/types'
import {quoteIdent,dialectFor} from '../dbviews/structureDdl'
import {MetadataNodeActions} from './MetadataNodeActions'
import {Icon} from '../Icon'
import {copyTextToClipboard} from '../../services/clipboard'
export function LazyTableColumns({connId,schema,table,engine,sqlActive,ownerKey=''}:{connId:string;schema:string;table:string;engine?:string;sqlActive:boolean;ownerKey?:string}){
  const {t}=useTranslation(),[structure,setStructure]=useState<TableStructure|null>(null),[error,setError]=useState<string|null>(null),[revision,setRevision]=useState(0)
  useEffect(()=>{let alive=true;setStructure(null);setError(null);void tableStructure(connId,schema,table).then(value=>{if(alive)setStructure(value)}).catch(error=>{if(alive)setError(dbErrMsg(error))});return()=>{alive=false}},[connId,schema,table,revision])
  useEffect(()=>{const changed=(event:Event)=>{const detail=(event as CustomEvent<{connId?:string}>).detail;if(!detail?.connId||detail.connId===connId)setRevision(value=>value+1)};window.addEventListener(SCHEMA_INVALIDATED_EVENT,changed);return()=>window.removeEventListener(SCHEMA_INVALIDATED_EVENT,changed)},[connId])
  if(error)return <div role="alert" style={{padding:'6px 10px 6px 42px',fontSize:11,color:'var(--danger-fg)',overflowWrap:'anywhere'}}>{error}<button className="btn btn-ghost sm" onClick={()=>setRevision(value=>value+1)}>{t('workbench.metadataRetry')}</button></div>
  if(!structure)return <div role="status" style={{padding:'6px 10px 6px 42px',fontSize:11,color:'var(--text-tertiary)'}}>{t('workbench.metadataLoading')}</div>
  return <div className="col" style={{paddingLeft:40}}>{structure.columns.length===0&&<span style={{fontSize:11,color:'var(--text-tertiary)'}}>{t('dbviews.noData')}</span>}{structure.columns.map(column=>{
    const insert=()=>window.dispatchEvent(new CustomEvent('catio-insert',{detail:{kind:'sql',text:quoteIdent(dialectFor(engine),column.name)}}))
    const items=[{id:'copy',icon:'copy',label:t('workbench.copyName'),action:()=>{void copyTextToClipboard(column.name).then(ok=>{if(!ok)setError(t('dbviews.copyFailed'))})}},...(sqlActive?[{id:'insert',icon:'arrow-right-to-line',label:t('workbench.insertName'),action:insert}]:[])]
    return <MetadataNodeActions key={column.name} ownerKey={JSON.stringify([ownerKey,connId,schema,table,column.name,revision])} title={t('workbench.schemaMenu')} items={items} className="row gap6" style={{minHeight:27,minWidth:0,paddingRight:5}}><Icon name={column.key==='PK'?'key':column.key==='FK'?'link':'columns'} size={11} style={{flex:'none',color:column.key==='PK'?'var(--signal-amber)':'var(--text-tertiary)'}}/><button title={column.comment||column.name} onDoubleClick={sqlActive?insert:undefined} className="mono ell" style={{fontSize:11,textAlign:'left',minWidth:0,color:'var(--text-secondary)',background:'transparent'}}>{column.name}</button><span className="mono ell" title={column.type} style={{marginLeft:'auto',fontSize:9.5,color:'var(--text-tertiary)',maxWidth:'43%'}}>{column.type}</span></MetadataNodeActions>
  })}</div>
}
