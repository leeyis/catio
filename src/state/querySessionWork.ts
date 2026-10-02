import { useSyncExternalStore } from 'react'
import type { QuerySessionInfo } from '../services/db'

export interface QuerySessionWork {
  connectionId: string
  profileId?: string
  workbenchId?: string
  ownerId?: string
  info: QuerySessionInfo
}
const work = new Map<string, QuerySessionWork>()
const listeners = new Set<() => void>()
let snapshot: QuerySessionWork[] = []
const emit = () => { snapshot = [...work.values()]; listeners.forEach(listener => listener()) }
export function updateQuerySessionWork(value: QuerySessionWork) {
  const old=work.get(value.info.id)
  if (old && old.connectionId===value.connectionId && old.profileId===value.profileId && old.workbenchId===value.workbenchId && old.ownerId===value.ownerId && old.info.transactionState===value.info.transactionState && old.info.busy===value.info.busy && old.info.canCancel===value.info.canCancel) return
  work.set(value.info.id,value);emit()
}
export function removeQuerySessionWork(id: string) {if(work.delete(id))emit()}
export function listQuerySessionWork() { return snapshot }
export function hasPendingQueryWork(filter: {profileId?:string;workbenchId?:string;ownerId?:string} = {}) {
  return snapshot.some(item => (!filter.profileId || item.profileId===filter.profileId) &&
    (!filter.workbenchId || item.workbenchId===filter.workbenchId) && (!filter.ownerId || item.ownerId===filter.ownerId) &&
    (item.info.busy || item.info.transactionState!=='idle'))
}
export function useQuerySessionWork() {
  return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}},()=>snapshot,()=>snapshot)
}
