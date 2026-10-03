import {useCallback,useEffect,useRef,useState} from 'react'
import {getSchema,loadSchemaNamespace,invalidateSchemaCache,SCHEMA_INVALIDATED_EVENT,dbErrMsg} from '../../services/db'
import type {Schema} from '../../services/types'

export function useMetadataTree(connId:string|undefined){
  const [schema,setSchema]=useState<Schema|null>(null)
  const [error,setError]=useState<string|null>(null)
  const [refreshError,setRefreshError]=useState<string|null>(null)
  const [loading,setLoading]=useState(false)
  const [refreshing,setRefreshing]=useState(false)
  const epoch=useRef(0)
  const sequence=useRef(0)
  const pending=useRef(new Map<string,number>())
  const loadCatalog=useCallback(async(initial:boolean)=>{
    if(!connId)return
    const version=++epoch.current;pending.current.clear();setError(null);setRefreshError(null)
    if(initial){setSchema(null);setLoading(true)}else setRefreshing(true)
    try{
      const result=await getSchema(connId,{lazy:true})
      if(version!==epoch.current)return
      setSchema(previous=>({...result,schemas:result.schemas.map(ns=>{
        const old=previous?.schemas.find(item=>item.name===ns.name)
        return ns.status==='unloaded'&&old?{...old,...ns,tables:old.tables,views:old.views,functions:old.functions}:ns
      })}))
    }catch(e){if(version===epoch.current)(initial?setError:setRefreshError)(dbErrMsg(e))}
    finally{if(version===epoch.current){setLoading(false);setRefreshing(false)}}
  },[connId])
  const refresh=useCallback(()=>{
    if(!connId)return
    setRefreshing(true)
    invalidateSchemaCache(connId)
  },[connId])
  const loadNamespace=useCallback(async(name:string,force=false)=>{
    if(!connId||(!force&&pending.current.has(name)))return
    if(force)invalidateSchemaCache(connId,{schema:name})
    const request=++sequence.current,version=epoch.current;pending.current.set(name,request)
    setSchema(current=>current?{...current,schemas:current.schemas.map(ns=>ns.name===name?{...ns,status:'loading',error:undefined}:ns)}:current)
    try{
      const result=await loadSchemaNamespace(connId,name)
      if(version===epoch.current&&pending.current.get(name)===request)setSchema(current=>current?{...current,schemas:current.schemas.map(ns=>ns.name===name?result:ns)}:current)
    }catch(e){
      if(version===epoch.current&&pending.current.get(name)===request)setSchema(current=>current?{...current,schemas:current.schemas.map(ns=>ns.name===name?{...ns,status:'error',error:dbErrMsg(e)}:ns)}:current)
    }finally{if(pending.current.get(name)===request)pending.current.delete(name)}
  },[connId])
  useEffect(()=>{
    if(!connId){epoch.current++;setSchema(null);setError(null);setRefreshError(null);setLoading(false);setRefreshing(false);return}
    void loadCatalog(true)
    let timer:ReturnType<typeof setTimeout>|undefined
    const invalidated=(event:Event)=>{
      const detail=(event as CustomEvent<{connId?:string;schema?:string}>).detail
      if(detail?.connId&&detail.connId!==connId)return
      if(detail?.schema){
        pending.current.delete(detail.schema)
        setSchema(current=>current?{...current,schemas:current.schemas.map(ns=>ns.name===detail.schema?{...ns,status:'unloaded',error:undefined}:ns)}:current)
      }else{clearTimeout(timer);timer=setTimeout(()=>{void loadCatalog(false)},100)}
    }
    window.addEventListener(SCHEMA_INVALIDATED_EVENT,invalidated)
    return()=>{epoch.current++;pending.current.clear();clearTimeout(timer);window.removeEventListener(SCHEMA_INVALIDATED_EVENT,invalidated)}
  },[connId,loadCatalog])
  return{schema,error,refreshError,loading,refreshing,refresh,loadNamespace,clearError:()=>setError(null),clearRefreshError:()=>setRefreshError(null)}
}
