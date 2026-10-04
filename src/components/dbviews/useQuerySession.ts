import { useCallback, useEffect, useRef, useState } from 'react'
import { openQuerySession, closeQuerySession, querySessionStatus, pingQuerySession, querySessionTransaction, invalidateSchemaCache, dbErrMsg,
  type QuerySessionInfo, type TransactionAction } from '../../services/db'
import { updateQuerySessionWork, removeQuerySessionWork } from '../../state/querySessionWork'

export function useQuerySession(connId: string | undefined, enabled: boolean,
  owner: {profileId?:string;workbenchId?:string;ownerId?:string}) {
  const [info,setInfo]=useState<QuerySessionInfo|null>(null)
  const [loading,setLoading]=useState(false)
  const [actionBusy,setActionBusy]=useState(false)
  const [error,setError]=useState<string|null>(null)
  const generation=useRef(0)
  const revision=useRef(0)
  const current=useRef<QuerySessionInfo|null>(null)
  const opening=useRef<Promise<QuerySessionInfo>|null>(null)
  const actionLock=useRef(false)
  const publish=useCallback((value:QuerySessionInfo)=>{
    const transactionEnded=current.current&&current.current.transactionState!=='idle'&&value.transactionState==='idle'
    revision.current++;current.current=value;setInfo(value)
    if(connId&&transactionEnded)invalidateSchemaCache(connId)
    if(connId)updateQuerySessionWork({connectionId:connId,profileId:owner.profileId,workbenchId:owner.workbenchId,ownerId:owner.ownerId,info:value})
  },[connId,owner.profileId,owner.workbenchId,owner.ownerId])
  const ensure=useCallback(async():Promise<QuerySessionInfo|undefined>=>{
    if(!enabled||!connId)return undefined
    if(current.current)return current.current
    if(opening.current)return opening.current
    const version=generation.current
    setLoading(true);setError(null)
    const request=openQuerySession(connId).then(value=>{
      if(version!==generation.current){void closeQuerySession(connId,value.id).catch(()=>{});throw new Error('SQL session owner changed')}
      publish(value);return value
    })
    opening.current=request
    try{return await request}catch(e){if(version===generation.current)setError(dbErrMsg(e));throw e}
    finally{if(version===generation.current&&opening.current===request){opening.current=null;setLoading(false)}}
  },[connId,enabled,publish])
  const refresh=useCallback(async()=>{
    const session=current.current;if(!enabled||!connId||!session)return
    const version=generation.current, before=revision.current
    try{
      const value=await querySessionStatus(connId,session.id)
      if(version===generation.current&&before===revision.current&&current.current?.id===session.id){publish(value);setError(null);return true}
    }catch(e){
      if(version===generation.current&&before===revision.current&&current.current?.id===session.id){publish({...session,busy:false,transactionState:'unknown'});setError(dbErrMsg(e))}
    }
  },[connId,enabled,publish])
  const markBusy=useCallback((busy:boolean)=>{if(current.current)publish({...current.current,busy})},[publish])
  const transact=useCallback(async(action:TransactionAction)=>{
    if(actionLock.current||!connId||!enabled)return
    actionLock.current=true;setActionBusy(true);setError(null)
    const version=generation.current
    let failure: string | null=null
    try{
      const session=await ensure();if(!session||version!==generation.current)return
      publish({...session,busy:true})
      const updated=await querySessionTransaction(connId,session.id,action)
      if(version===generation.current)publish(updated)
    }catch(e){failure=dbErrMsg(e)}
    finally{if(version===generation.current){await refresh();if(failure)setError(failure);actionLock.current=false;setActionBusy(false)}}
  },[connId,enabled,ensure,publish,refresh])
  const reconnect=useCallback(async()=>{
    if(actionLock.current||!connId||!enabled)return
    actionLock.current=true;setActionBusy(true);setError(null)
    let version=generation.current
    try{
      const old=current.current
      if(old)await closeQuerySession(connId,old.id)
      if(version!==generation.current)return
      if(old)removeQuerySessionWork(old.id)
      generation.current++;version=generation.current;current.current=null;opening.current=null;setInfo(null)
      await ensure()
    }catch(e){if(version===generation.current)setError(dbErrMsg(e))}
    finally{if(version===generation.current){actionLock.current=false;setActionBusy(false)}}
  },[connId,enabled,ensure])
  useEffect(()=>{
    generation.current++;current.current=null;opening.current=null;actionLock.current=false
    setInfo(null);setError(null);setLoading(false);setActionBusy(false)
    if(!enabled||!connId)return
    void ensure().catch(()=>{})
    let pingInFlight=false, heartbeatNeedsRefresh=false
    const timer=setInterval(()=>{
      const session=current.current;if(!session||pingInFlight)return
      const version=generation.current
      pingInFlight=true
      void pingQuerySession(connId,session.id).then(async()=>{
        if(version!==generation.current||current.current?.id!==session.id)return
        // A successful lease ping does not prove transaction state. Read it back,
        // preserving the same physical session (never reconnect/rollback implicitly).
        if(heartbeatNeedsRefresh&&!current.current.busy&&!actionLock.current){
          heartbeatNeedsRefresh=!(await refresh())
        }
      }).catch(e=>{
        if(version===generation.current&&current.current?.id===session.id){
          heartbeatNeedsRefresh=true
          publish({...current.current,transactionState:'unknown'});setError(dbErrMsg(e))
        }
      }).finally(()=>{pingInFlight=false})
    },30_000)
    return()=>{
      clearInterval(timer);generation.current++
      const session=current.current;current.current=null;opening.current=null
      if(session){removeQuerySessionWork(session.id);void closeQuerySession(connId,session.id).catch(()=>{})}
    }
  },[connId,enabled,ensure,publish,refresh])
  return {info,loading,actionBusy,error,ensure,refresh,markBusy,transact,reconnect,current}
}
