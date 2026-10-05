import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'

export interface MetadataAction { id: string; label: string; icon: string; action: () => void; danger?: boolean; disabled?: boolean; testId?: string }
/** One menu model and one renderer for pointer, context-menu and keyboard entry. */
export function MetadataNodeActions({ children, items, ownerKey, title, triggerTestId, className, style,showTrigger=true,triggerLabel }: {
  showTrigger?:boolean;triggerLabel?:string;
  children: ReactNode; items: MetadataAction[]; ownerKey: string; title: string; triggerTestId?: string; className?: string; style?: CSSProperties
}) {
  const [position,setPosition]=useState<{x:number;y:number;owner:string;items:MetadataAction[]}|null>(null)
  const root=useRef<HTMLDivElement>(null),menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
  const availability=items.map(item=>item.id+':'+!!item.disabled).join('|')
  const effectiveOwner=JSON.stringify([ownerKey,availability])
  const valid=position?.owner===effectiveOwner
  useEffect(()=>{setPosition(null)},[ownerKey,availability])
  const open=(event:MouseEvent,context=false)=>{
    if(!items.length)return
    event.preventDefault();event.stopPropagation()
    const rect=trigger.current?.getBoundingClientRect()
    setPosition({x:context?event.clientX:(rect?.left??0),y:context?event.clientY:(rect?.bottom??0),owner:effectiveOwner,items:[...items]})
  }
  useLayoutEffect(()=>{
    if(!position||!valid||!menu.current)return
    const rect=menu.current.getBoundingClientRect()
    menu.current.style.left=Math.max(6,Math.min(position.x,window.innerWidth-rect.width-6))+'px'
    menu.current.style.top=Math.max(6,Math.min(position.y,window.innerHeight-rect.height-6))+'px'
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  },[position,valid])
  useEffect(()=>{
    if(!position)return
    const outside=(event:globalThis.MouseEvent)=>{if(!menu.current?.contains(event.target as Node)&&!root.current?.contains(event.target as Node))setPosition(null)}
    const scroll=(event:Event)=>{if(!menu.current?.contains(event.target as Node))setPosition(null)}
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setPosition(null);trigger.current?.focus()}}
    document.addEventListener('mousedown',outside);document.addEventListener('keydown',key)
    window.addEventListener('resize',scroll);window.addEventListener('scroll',scroll,true)
    return()=>{document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',key);window.removeEventListener('resize',scroll);window.removeEventListener('scroll',scroll,true)}
  },[position])
  return <div ref={root} className={className} style={style} onContextMenu={event=>open(event,true)} onKeyDown={event=>{
    if((event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')&&items.length){event.preventDefault();event.stopPropagation();const rect=root.current?.getBoundingClientRect();setPosition({x:rect?.left??0,y:rect?.bottom??0,owner:effectiveOwner,items:[...items]})}
  }}>
    {children}
    {showTrigger&&!!items.length&&<button ref={trigger} type="button" className={triggerLabel?'btn btn-secondary sm':'icon-btn bare'} data-testid={triggerTestId} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={!!valid} onClick={event=>{if(valid){event.preventDefault();event.stopPropagation();setPosition(null)}else open(event)}} style={{width:triggerLabel?undefined:22,height:triggerLabel?undefined:22,flex:'none'}}><Icon name="more-horizontal" size={13}/>{triggerLabel}</button>}
    {valid&&position&&createPortal(<div ref={menu} role="menu" aria-label={title} onClick={event=>event.stopPropagation()} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
      event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const current=buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(current+1)%buttons.length:(current+buttons.length-1)%buttons.length;buttons[next]?.focus()
    }} style={{position:'fixed',left:position.x,top:position.y,zIndex:300,minWidth:180,maxWidth:'calc(100vw - 12px)',maxHeight:'calc(100vh - 12px)',overflowY:'auto',padding:5,borderRadius:9,background:'var(--surface-elevated)',border:'1px solid var(--border-hairline-alt)',boxShadow:'var(--shadow-dropdown)'}}>
      {position.items.map(item=><button key={item.id} role="menuitem" type="button" data-testid={item.testId} disabled={item.disabled} className="row gap8 sel-pill" style={{width:'100%',textAlign:'left',padding:'8px 10px',fontSize:12,color:item.danger?'var(--danger-fg)':'var(--text-primary)'}} onClick={()=>{setPosition(null);if(position.owner===effectiveOwner&&!item.disabled)item.action()}}><Icon name={item.icon} size={14}/><span>{item.label}</span></button>)}
    </div>,document.body)}
  </div>
}
