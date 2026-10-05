import { createContext,useContext,useEffect,useSyncExternalStore,type ReactNode } from 'react'
import { hasPendingQueryWork } from './querySessionWork'
export interface DatabaseWorkOwner { ownerId:string;workbenchId:string;profileId:string }
export interface DatabaseDraftWork extends DatabaseWorkOwner { kind:string;dirty:boolean;busy:boolean }
const Owner=createContext<DatabaseWorkOwner|null>(null)
const work=new Map<string,DatabaseDraftWork>(),listeners=new Set<()=>void>()
let snapshot:DatabaseDraftWork[]=[]
const emit=()=>{snapshot=[...work.values()];listeners.forEach(listener=>listener())}
export const DatabaseWorkProvider=({owner,children}:{owner:DatabaseWorkOwner;children:ReactNode})=><Owner.Provider value={owner}>{children}</Owner.Provider>
export function updateDatabaseDraftWork(value:DatabaseDraftWork){const key=JSON.stringify([value.ownerId,value.kind]);const old=work.get(key);if(old&&old.dirty===value.dirty&&old.busy===value.busy&&old.workbenchId===value.workbenchId&&old.profileId===value.profileId)return;work.set(key,value);emit()}
export function removeDatabaseDraftWork(ownerId:string,kind:string){if(work.delete(JSON.stringify([ownerId,kind])))emit()}
export function useReportDatabaseWork(kind:string,dirty:boolean,busy=false){
  const owner=useContext(Owner)
  useEffect(()=>{if(owner)updateDatabaseDraftWork({...owner,kind,dirty,busy})},[owner?.ownerId,owner?.workbenchId,owner?.profileId,kind,dirty,busy])
  useEffect(()=>()=>{if(owner)removeDatabaseDraftWork(owner.ownerId,kind)},[owner?.ownerId,kind])
}
export function useDatabaseDraftWork(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}},()=>snapshot,()=>snapshot)}
export function listDatabaseDraftWork(){return snapshot}
export function hasPendingDatabaseWork(filter:{profileId?:string;workbenchId?:string;ownerId?:string}={}){
  return hasPendingQueryWork(filter)||snapshot.some(item=>(!filter.profileId||item.profileId===filter.profileId)&&(!filter.workbenchId||item.workbenchId===filter.workbenchId)&&(!filter.ownerId||item.ownerId===filter.ownerId)&&(item.dirty||item.busy))
}
export function hasBusyDatabaseDraftWork(filter:{workbenchId?:string;ownerId?:string}={}){return snapshot.some(item=>(!filter.workbenchId||item.workbenchId===filter.workbenchId)&&(!filter.ownerId||item.ownerId===filter.ownerId)&&item.busy)}
