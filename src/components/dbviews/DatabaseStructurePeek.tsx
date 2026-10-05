import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { loadSchemaNamespace, tableStructure, dbErrMsg, SCHEMA_INVALIDATED_EVENT } from '../../services/db'
import type { SchemaNamespace, TableStructure } from '../../services/types'

/** An explicit metadata-only lookup. Never guesses a table from SQL text, changes
 * the query namespace, fetches table rows, or executes generated DDL. */
export function DatabaseStructurePeek({connId,schemas,defaultSchema,onClose}:{connId:string;schemas:string[];defaultSchema?:string;onClose:()=>void}) {
  const {t}=useTranslation()
  const root=useRef<HTMLElement>(null)
  const [schema,setSchema]=useState(()=>schemas.includes(defaultSchema??'')?defaultSchema!:schemas[0]??'')
  const [table,setTable]=useState(''),[catalog,setCatalog]=useState<SchemaNamespace|null>(null)
  const [structure,setStructure]=useState<TableStructure|null>(null),[error,setError]=useState<string|null>(null)
  const [loading,setLoading]=useState(false),[revision,setRevision]=useState(0)
  useEffect(()=>{const before=document.activeElement as HTMLElement|null;root.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>{if(before?.isConnected)before.focus()}},[])
  useEffect(()=>{const changed=(event:Event)=>{const id=(event as CustomEvent<{connId?:string}>).detail?.connId;if(!id||id===connId)setRevision(v=>v+1)};window.addEventListener(SCHEMA_INVALIDATED_EVENT,changed);return()=>window.removeEventListener(SCHEMA_INVALIDATED_EVENT,changed)},[connId])
  useEffect(()=>{
    let alive=true;setCatalog(null);setStructure(null);setError(null);setLoading(!!schema)
    if(schema)void loadSchemaNamespace(connId,schema).then(value=>{if(alive){setCatalog(value);if(value.status==='error')setError(value.error??t('workbench.metadataUnavailable'));setTable(current=>[...value.tables,...value.views].some(item=>item.name===current)?current:'')}}).catch(e=>{if(alive)setError(dbErrMsg(e))}).finally(()=>{if(alive)setLoading(false)})
    return()=>{alive=false}
  },[connId,schema,revision,t])
  useEffect(()=>{
    let alive=true;setStructure(null)
    if(!table||!catalog)return
    setError(null);setLoading(true)
    void tableStructure(connId,schema,table).then(value=>{if(alive)setStructure(value)}).catch(e=>{if(alive)setError(dbErrMsg(e))}).finally(()=>{if(alive)setLoading(false)})
    return()=>{alive=false}
  },[connId,schema,table,catalog])
  return <aside ref={root} role="complementary" aria-label={t('dbviews.structurePeek')} onKeyDown={event=>{event.stopPropagation();if(!event.nativeEvent.isComposing&&event.key==='Escape'){event.preventDefault();onClose()}}} className="col" style={{position:'absolute',right:0,top:0,bottom:0,zIndex:90,width:460,maxWidth:'96%',background:'var(--surface-card)',borderLeft:'1px solid var(--border-hairline)',boxShadow:'var(--shadow-dropdown)',minHeight:0}}>
    <div className="row gap8" style={{padding:12,borderBottom:'1px solid var(--border-hairline)'}}><Icon name="columns" size={15}/><strong>{t('dbviews.structurePeek')}</strong><button className="icon-btn bare" aria-label={t('shell.close')} onClick={onClose} style={{marginLeft:'auto'}}><Icon name="x" size={15}/></button></div>
    <div className="col gap8" style={{padding:12,fontSize:12}}><span style={{color:'var(--text-tertiary)'}}>{t('dbviews.structurePeekHint')}</span>
      <label className="col gap4">{t('workbench.defaultSchema')}<select aria-label={t('workbench.defaultSchema')} value={schema} onChange={e=>{setTable('');setSchema(e.target.value)}} style={{background:'var(--surface-sunken)',color:'var(--text-primary)',padding:6}}>{schemas.map(name=><option key={name}>{name}</option>)}</select></label>
      <label className="col gap4">{t('dbviews.peekObject')}<select aria-label={t('dbviews.peekObject')} value={table} disabled={!catalog} onChange={e=>setTable(e.target.value)} style={{background:'var(--surface-sunken)',color:'var(--text-primary)',padding:6}}><option value="">{t('dbviews.peekChooseObject')}</option>{[...(catalog?.tables??[]),...(catalog?.views??[])].map(object=><option key={object.name}>{object.name}</option>)}</select></label>
    </div>
    {loading&&<div role="status" style={{padding:12}}>{t('workbench.metadataLoading')}</div>}
    {error&&<div role="alert" style={{padding:12,color:'var(--danger-fg)',overflowWrap:'anywhere'}}>{error}<button className="btn btn-ghost sm" onClick={()=>setRevision(v=>v+1)}>{t('workbench.metadataRetry')}</button></div>}
    {structure&&<div className="grow scrollon" style={{overflow:'auto',padding:12,fontSize:12}}><strong className="mono" style={{overflowWrap:'anywhere'}}>{schema}.{table}</strong>{structure.comment&&<p>{structure.comment}</p>}
      <dl style={{margin:'12px 0'}}>{structure.columns.map(column=><div key={column.name} style={{borderBottom:'1px solid var(--border-hairline)',padding:'8px 0'}}><dt className="row gap8"><b className="mono" style={{overflowWrap:'anywhere'}}>{column.name}</b>{column.key&&<span className="chip">{column.key}</span>}</dt><dd className="mono" style={{margin:'4px 0',overflowWrap:'anywhere',color:'var(--text-secondary)'}}>{column.type}{column.nullable?' · NULL':' · NOT NULL'}{column.default!==null?' · DEFAULT '+column.default:''}</dd>{column.comment&&<dd style={{margin:0,color:'var(--text-tertiary)'}}>{column.comment}</dd>}</div>)}</dl>
      <details><summary>{t('dbviews.peekIndexes')} · {structure.indexes.length}</summary>{structure.indexes.map(index=><p key={index.name} className="mono" style={{overflowWrap:'anywhere'}}>{index.name}: {index.cols} {index.unique?'UNIQUE':''} {index.method}</p>)}</details>
      <details><summary>{t('dbviews.peekForeignKeys')} · {structure.fks.length}</summary>{structure.fks.map((fk,index)=><p key={index} className="mono" style={{overflowWrap:'anywhere'}}>{fk.col} → {fk.ref} · ON DELETE {fk.onDelete} · ON UPDATE {fk.onUpdate}</p>)}</details>
    </div>}
  </aside>
}
