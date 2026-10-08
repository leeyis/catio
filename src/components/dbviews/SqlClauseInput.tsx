import {useEffect,useId,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {Icon} from '../Icon'
import {clauseSuggest,applyClauseItem,type ClauseMode,type ClauseSuggest,type ClauseItem} from './clauseComplete'
import './sqlClauseInput.css'

interface Props {mode:ClauseMode;value:string;onChange:(value:string)=>void;columns:string[];engine?:string;onSubmit:()=>void;submitDisabled?:boolean}
/** One shared mouse/keyboard flow. Accepting a suggestion only changes the draft. */
export function SqlClauseInput({mode,value,onChange,columns,engine,onSubmit,submitDisabled}:Props){
  const {t}=useTranslation(),id=useId(),input=useRef<HTMLInputElement>(null),composing=useRef(false)
  const [suggest,setSuggest]=useState<ClauseSuggest|null>(null),[active,setActive]=useState(0)
  const accepted=useRef<{value:string;cursor:number}|null>(null)
  const observed=useRef<{value:string;start:number|null;end:number|null}|null>(null)
  const items=suggest?.source===value?suggest.items:[],open=items.length>0,index=Math.min(active,Math.max(0,items.length-1))
  const label=mode==='where'?'WHERE':'ORDER BY'
  function refresh(el:HTMLInputElement,force=false){
    const before=observed.current
    if(!force&&before?.value===el.value&&before.start===el.selectionStart&&before.end===el.selectionEnd)return
    observed.current={value:el.value,start:el.selectionStart,end:el.selectionEnd}
    const cursor=el.selectionStart??el.value.length
    if(composing.current||el.selectionEnd!==cursor){setSuggest(null);return}
    if(accepted.current?.value===el.value&&accepted.current.cursor===cursor)return
    accepted.current=null;setActive(0);setSuggest(clauseSuggest(el.value,cursor,columns,mode,engine))
  }
  function accept(item:ClauseItem){
    const el=input.current;if(!el||!suggest||composing.current||el.selectionStart!==el.selectionEnd)return
    const fresh=clauseSuggest(el.value,el.selectionStart??el.value.length,columns,mode,engine)
    if(fresh.start!==suggest.start||fresh.end!==suggest.end||!fresh.items.some(i=>i.insert===item.insert&&i.kind===item.kind)){setSuggest(null);return}
    const result=applyClauseItem(el.value,fresh,item)
    accepted.current=result;setSuggest(null);onChange(result.value)
    requestAnimationFrame(()=>{if(input.current===el&&el.value===result.value){el.focus();el.setSelectionRange(result.cursor,result.cursor)}})
  }
  const columnKey=JSON.stringify(columns.slice(0,10000))
  useEffect(()=>{setSuggest(null);accepted.current=null},[engine,mode,columnKey])
  useEffect(()=>{if(open)document.getElementById(`${id}-${index}`)?.scrollIntoView?.({block:'nearest'})},[id,index,open])
  return <div className="db-clause-input">
    <input ref={input} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open?id:undefined} aria-activedescendant={open?`${id}-${index}`:undefined}
      aria-label={t(mode==='where'?'dbviews.whereClause':'dbviews.orderByClause')} placeholder={label} className="mono" value={value} spellCheck={false} autoComplete="off"
      onChange={e=>{accepted.current=null;onChange(e.target.value);refresh(e.currentTarget)}}
      onFocus={e=>refresh(e.currentTarget,true)} onSelect={e=>refresh(e.currentTarget)} onClick={e=>refresh(e.currentTarget,true)}
      onBlur={()=>{setSuggest(null);accepted.current=null}}
      onCompositionStart={()=>{composing.current=true;setSuggest(null)}} onCompositionEnd={e=>{composing.current=false;refresh(e.currentTarget,true)}}
      onKeyDown={e=>{
        if(composing.current||e.nativeEvent.isComposing||e.keyCode===229)return
        if(open&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();e.stopPropagation();setActive((index+(e.key==='ArrowDown'?1:items.length-1))%items.length)}
        else if(open&&(e.key==='Tab'||e.key==='Enter')){e.preventDefault();e.stopPropagation();accept(items[index])}
        else if(e.key==='Escape'){if(open){e.preventDefault();e.stopPropagation()}setSuggest(null)}
        else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(!submitDisabled)onSubmit()}
      }}/>
    {open&&<div id={id} role="listbox" aria-label={t('dbviews.clauseSuggestions')} className="db-clause-options pop-in">
      {items.map((item,i)=><button key={item.kind+':'+item.label} type="button" role="option" tabIndex={-1} id={`${id}-${i}`} aria-selected={index===i}
        onMouseEnter={()=>setActive(i)} onMouseDown={e=>{e.preventDefault();accept(item)}} onClick={e=>{if(e.detail===0)accept(item)}}>
        <Icon name={item.kind==='column'?'columns':'command'} size={12}/><span className="mono">{item.label}</span>{item.detail&&<small>{item.detail}</small>}
      </button>)}
    </div>}
  </div>
}
