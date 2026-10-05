import {useEffect,useMemo,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {Icon} from '../Icon'
import {copyTextToClipboard} from '../../services/clipboard'
import {rawValueText,formatJsonValue} from './valueInspector'
export interface InspectedDatabaseValue {label:string;value:unknown;type:string;binary:boolean;binaryKnown:boolean}
export function DatabaseValueInspector({cell,onClose}:{cell:InspectedDatabaseValue;onClose:()=>void}){
  const {t}=useTranslation(),root=useRef<HTMLElement>(null)
  const raw=useMemo(()=>rawValueText(cell.value),[cell.value])
  const formatted=useMemo(()=>!cell.binary&&cell.value!=null?formatJsonValue(raw):null,[raw,cell.binary,cell.value])
  const [pretty,setPretty]=useState(false),[copied,setCopied]=useState(false),[error,setError]=useState(false)
  useEffect(()=>{const before=document.activeElement as HTMLElement|null;root.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>{if(before?.isConnected)before.focus()}},[])
  useEffect(()=>{setPretty(false);setCopied(false);setError(false)},[cell])
  const length=cell.value==null?null:cell.binary&&/^0x(?:[0-9a-f]{2})*$/i.test(raw)?(raw.length-2)/2:raw.length
  return <aside ref={root} role="complementary" aria-label={t('dbviews.cellContent')} className="col" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose()}}} style={{position:'absolute',right:0,top:0,bottom:0,zIndex:65,width:400,maxWidth:'95%',background:'var(--surface-card)',borderLeft:'1px solid var(--border-hairline-alt)',boxShadow:'var(--shadow-dropdown)',minHeight:0}}>
    <div className="row gap8" style={{padding:'12px 14px',borderBottom:'1px solid var(--border-hairline)'}}><Icon name="panel-right" size={16}/><strong className="ell" style={{fontSize:13}}>{t('dbviews.cellContent')}</strong><button className="icon-btn bare" aria-label={t('shell.close')} onClick={onClose} style={{marginLeft:'auto'}}><Icon name="x" size={15}/></button></div>
    <div className="col" style={{padding:'12px 14px',gap:8,fontSize:12}}><strong className="mono" style={{overflowWrap:'anywhere'}}>{cell.label}</strong><span>{t('dbviews.valueType')}: <span className="mono">{cell.type||'—'}</span></span><span className="chip" style={{alignSelf:'flex-start'}}>{t(cell.value==null?'dbviews.valueNull':!cell.binaryKnown?'dbviews.valueUnknown':cell.binary?'dbviews.valueBinary':'dbviews.valueText')}</span><span>{t('dbviews.valueLength')}: {length?.toLocaleString()??'—'}{cell.binary?' B':''}</span></div>
    <div className="row gap6" style={{padding:'0 14px 10px'}}><button className="btn btn-secondary sm" aria-pressed={!pretty} onClick={()=>setPretty(false)}>{t('dbviews.valueRaw')}</button>{formatted!==null&&<button className="btn btn-secondary sm" aria-pressed={pretty} onClick={()=>setPretty(true)}>{t('dbviews.valueFormatted')}</button>}<button className="btn ghost sm" onClick={()=>{void copyTextToClipboard(pretty?formatted??raw:raw).then(ok=>{setCopied(ok);setError(!ok)})}}><Icon name={copied?'check':'copy'} size={13}/>{t(copied?'dbviews.copied':'dbviews.copySel')}</button></div>
    {error&&<div role="alert" style={{padding:'4px 14px',color:'var(--danger-fg)',fontSize:12}}>{t('dbviews.copyFailed')}</div>}
    <pre className="mono grow scrollon" data-testid="db-value-content" style={{margin:0,padding:14,fontSize:12,lineHeight:1.6,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',color:'var(--text-primary)',background:'var(--surface-subtle)'}}>{pretty?formatted:raw}</pre>
  </aside>
}
