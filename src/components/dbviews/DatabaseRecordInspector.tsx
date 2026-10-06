import {useEffect,useRef} from 'react'
import {useTranslation} from 'react-i18next'
import {Icon} from '../Icon'
import {rawValueText} from './valueInspector'
import type {InspectedDatabaseValue} from './DatabaseValueInspector'

/** Docked, read-only row inspection. Keyboard events are scoped to this pane,
 * never captured from a sibling SQL editor or a hidden workbench. */
export function DatabaseRecordInspector({number,cells,canPrev,canNext,onPrev,onNext,onClose,onInspect}:{
  number:number;cells:InspectedDatabaseValue[];canPrev:boolean;canNext:boolean;
  onPrev:()=>void;onNext:()=>void;onClose:()=>void;onInspect:(cell:InspectedDatabaseValue)=>void
}) {
  const {t}=useTranslation(),root=useRef<HTMLElement>(null)
  useEffect(()=>{const before=document.activeElement as HTMLElement|null;root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();return()=>{if(before?.isConnected)before.focus()}},[])
  return <aside ref={root} className="db-record-panel" aria-label={t('dbviews.rowDetail')} onKeyDown={event=>{
    event.stopPropagation()
    if(event.key==='Escape'){event.preventDefault();onClose()}
    else if(event.key==='ArrowUp'&&canPrev){event.preventDefault();onPrev()}
    else if(event.key==='ArrowDown'&&canNext){event.preventDefault();onNext()}
  }}>
    <div className="db-record-header"><Icon name="panel-right" size={14}/><strong>{t('dbviews.rowDetail')}[{number}]</strong>
      <div className="row gap2" style={{marginLeft:'auto'}}>
        <button className="icon-btn bare" title={t('dbviews.prevRow')} disabled={!canPrev} onClick={onPrev}><Icon name="chevron-up" size={14}/></button>
        <button className="icon-btn bare" title={t('dbviews.nextRow')} disabled={!canNext} onClick={onNext}><Icon name="chevron-down" size={14}/></button>
        <button className="icon-btn bare" aria-label={t('shell.close')} onClick={onClose}><Icon name="x" size={14}/></button>
      </div>
    </div>
    <div className="db-record-fields scrollon">{cells.map((cell,index)=>{
      const raw=rawValueText(cell.value),short=raw.length>4000?raw.slice(0,4000)+'…':raw
      const type=cell.value==null?'dbviews.valueNull':cell.value===''?'dbviews.workspace.emptyString':cell.binary?'dbviews.valueBinary':!cell.binaryKnown?'dbviews.valueUnknown':null
      return <div className="db-record-field" key={index}>
        <div className="db-record-field-label"><strong className="mono">{cell.label}</strong><small className="mono">{cell.type||'—'}</small><button className="icon-btn bare" title={t('dbviews.viewFull')} onClick={()=>onInspect(cell)}><Icon name="external-link" size={12}/></button></div>
        {type&&<span className="db-record-type">{t(type)}</span>}
        <pre className="mono">{!cell.binary&&typeof cell.value==='string'&&/^https?:\/\/\S+$/i.test(raw)&&raw.length<=4000?<a href={raw} target="_blank" rel="noreferrer" style={{color:'var(--accent-primary)'}}>{raw}</a>:short}</pre>
        {raw.length>4000&&<small style={{color:'var(--text-tertiary)'}}>{t('dbviews.workspace.previewClipped')}</small>}
      </div>
    })}</div>
  </aside>
}
