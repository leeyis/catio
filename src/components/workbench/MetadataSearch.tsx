import {useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {searchSchemaObjects,cancelMetadataSearch,dbErrMsg,type MetadataSearchResult} from '../../services/db'
import {Icon} from '../Icon'

export function MetadataSearch({connId,query,onPick,onPickObject,onPin,onPinObject}:{connId:string;query:string;
  onPick:(schema:string,name:string)=>void;onPickObject?:(schema:string,name:string,kind:'view'|'function'|'procedure')=>void;
  onPin?:(schema:string,name:string)=>void;onPinObject?:(schema:string,name:string,kind:'view'|'function'|'procedure')=>void}){
  const {t}=useTranslation()
  const [result,setResult]=useState<MetadataSearchResult|null>(null)
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null)
  const active=useRef<string|null>(null)
  useEffect(()=>{
    setResult(null);setError(null)
    const text=query.trim();if(!text){setLoading(false);return}
    let alive=true,started=false
    const id='metadata-'+(globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
    active.current=id;setLoading(true)
    const timer=setTimeout(()=>{
      started=true
      void searchSchemaObjects(connId,text,id).then(value=>{if(alive)setResult(value)})
        .catch(e=>{if(alive)setError(dbErrMsg(e))}).finally(()=>{if(alive){setLoading(false);active.current=null}})
    },250)
    return()=>{alive=false;clearTimeout(timer);if(started)void cancelMetadataSearch(connId,id).catch(()=>{});if(active.current===id)active.current=null}
  },[connId,query])
  if(!query.trim())return null
  return <div className="col" style={{gap:6,padding:'8px 6px'}}>
    <div className="row" style={{justifyContent:'space-between',fontSize:11,color:'var(--text-tertiary)'}}>
      <span>{t(loading?'workbench.searchAllLoading':'workbench.searchAllNamespaces')}</span>
      {loading&&<button className="icon-btn bare" title={t('dbviews.stop')} onClick={()=>{const id=active.current;if(id)void cancelMetadataSearch(connId,id).catch(e=>setError(dbErrMsg(e)))}}><Icon name="square" size={12}/></button>}
    </div>
    {error&&<div role="alert" style={{fontSize:11.5,color:'var(--danger-fg)',overflowWrap:'anywhere'}}>{error}</div>}
    {result?.objects.map(object=><button key={JSON.stringify([object.schema,object.kind,object.name])}
      className="row gap6" title={`${object.schema}.${object.name}`} onDoubleClick={()=>{if(object.kind==='table')onPin?.(object.schema,object.name);else onPinObject?.(object.schema,object.name,object.kind as 'view'|'function'|'procedure')}} onClick={()=>{
        if(onPickObject&&['view','function','procedure'].includes(object.kind))onPickObject(object.schema,object.name,object.kind as 'view'|'function'|'procedure')
        else onPick(object.schema,object.name)
      }} style={{textAlign:'left',padding:'7px 8px',background:'var(--surface-subtle)',border:'1px solid var(--border-hairline)',borderRadius:6,color:'var(--text-primary)',fontSize:12}}>
      <Icon name={object.kind==='table'?'table-2':object.kind==='view'?'eye':'function-square'} size={13}/>
      <span className="ell">{object.schema}.{object.name}</span>
    </button>)}
    {result&&!loading&&result.objects.length===0&&result.errors.length===0&&!result.cancelled&&!result.truncated&&<span style={{fontSize:12,color:'var(--text-faint)'}}>{t('workbench.searchNoObjects')}</span>}
    {result?.truncated&&<span role="status" style={{fontSize:11,color:'var(--signal-amber)'}}>{t('workbench.searchIncomplete')}</span>}
    {result?.cancelled&&<span role="status" style={{fontSize:11,color:'var(--text-tertiary)'}}>{t('workbench.searchCancelled')}</span>}
    {!!result?.errors.length&&<details style={{fontSize:11,color:'var(--danger-fg)'}}><summary>{t('workbench.searchMetadataErrors',{count:result.errors.length})}</summary>
      {result.errors.map((item,index)=><div key={index} style={{padding:'4px 0',overflowWrap:'anywhere'}}>{item.schema}: {item.message}</div>)}
    </details>}
  </div>
}
