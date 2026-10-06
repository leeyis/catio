import { useEffect, useRef, useState } from 'react'
import { copyTextToClipboard } from '../services/clipboard'

/** A clipboard request is not a receipt. Late replies cannot label newer content as copied. */
export function useCopyFeedback(text: string) {
  const [status,setStatus]=useState<'idle'|'pending'|'copied'|'error'>('idle')
  const generation=useRef(0), timer=useRef<ReturnType<typeof setTimeout>>()
  useEffect(()=>{
    generation.current++;setStatus('idle')
    return ()=>{generation.current++;clearTimeout(timer.current)}
  },[text])
  async function copy(){
    const token=++generation.current
    clearTimeout(timer.current);setStatus('pending')
    let ok=false
    try{ok=await copyTextToClipboard(text)}catch{/* Keep even unexpected clipboard failures visible. */}
    if(token!==generation.current)return
    setStatus(ok?'copied':'error')
    if(ok)timer.current=setTimeout(()=>{if(token===generation.current)setStatus('idle')},1400)
  }
  return {copy,copied:status==='copied',copyError:status==='error',copying:status==='pending'}
}
