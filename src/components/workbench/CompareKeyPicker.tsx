import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { tableStructure, dbErrMsg } from '../../services/db'
import { compareKeyStatus } from './compareKeys'
import type { TableStructure } from '../../services/types'
import { Btn } from '../atoms'

interface Target { connId:string; schema:string; table:string }
export function CompareKeyPicker({source,target,selected,disabled,onSelect}:{source:Target;target:Target;selected:string[];disabled:boolean;onSelect:(keys:string[])=>void}) {
  const {t}=useTranslation()
  const identity=JSON.stringify([source.connId,source.schema,source.table,target.connId,target.schema,target.table])
  const [model,setModel]=useState<{identity:string;source:TableStructure;target:TableStructure}|null>(null)
  const [failure,setFailure]=useState<{identity:string;message:string}|null>(null),[reload,setReload]=useState(0)
  useEffect(()=>{
    if(!source.table || !target.table)return
    let alive=true;setModel(null);setFailure(null)
    void Promise.all([tableStructure(source.connId,source.schema,source.table),tableStructure(target.connId,target.schema,target.table)])
      .then(([src,tgt])=>{if(alive)setModel({identity,source:src,target:tgt})})
      .catch(e=>{if(alive)setFailure({identity,message:dbErrMsg(e)})})
    return ()=>{alive=false}
  },[identity,reload,source.connId,source.schema,source.table,target.connId,target.schema,target.table])
  const current=model?.identity===identity?model:null
  const common=current?current.source.columns.filter(c=>current.target.columns.some(tc=>tc.name===c.name)):[]
  const status=current?compareKeyStatus(current.source,current.target,selected):null
  return <section className="db-compare-keys" aria-label={t('compareKeys.columns')}>
    <p className="db-compare-note">{t('compareKeys.scope')}</p>
    {!source.table||!target.table?<p>{t('compareKeys.chooseTables')}</p>:!current&&!failure?<p role="status">{t('dbflow.loadingColumns')}</p>:null}
    {failure?.identity===identity&&<p role="alert">{failure.message} <Btn size="sm" disabled={disabled} onClick={()=>{onSelect([]);setReload(r=>r+1)}}>{t('dbflow.reloadColumns')}</Btn></p>}
    <div className="row" style={{gap:12,flexWrap:'wrap'}}>{common.map(column=><label className="row gap6" key={column.name}><input type="checkbox" disabled={disabled} checked={selected.includes(column.name)} onChange={()=>onSelect(selected.includes(column.name)?selected.filter(c=>c!==column.name):[...selected,column.name])}/><span className="mono">{column.name}</span></label>)}</div>
    {current&&!common.length&&<p role="alert">{t('compareKeys.noCommon')}</p>}
    {status?.valid&&!status.unique&&<p className="db-compare-note">{t('compareKeys.readOnly')}</p>}
  </section>
}
