import {beforeEach,describe,it,expect} from 'vitest'
import {hasPendingQueryWork,listQuerySessionWork,removeQuerySessionWork,updateQuerySessionWork} from './querySessionWork'
beforeEach(()=>{listQuerySessionWork().forEach(item=>removeQuerySessionWork(item.info.id))})
describe('query-session close guards',()=>{
  it('scopes pending work to the correct profile, workbench and query owner',()=>{
    updateQuerySessionWork({connectionId:'c',profileId:'p',workbenchId:'w',ownerId:'q',info:{id:'s',transactionState:'active',busy:false,canCancel:true,leaseSeconds:1800}})
    expect(hasPendingQueryWork()).toBe(true)
    expect(hasPendingQueryWork({profileId:'other'})).toBe(false)
    expect(hasPendingQueryWork({workbenchId:'other'})).toBe(false)
    expect(hasPendingQueryWork({ownerId:'other'})).toBe(false)
    expect(hasPendingQueryWork({ownerId:'q'})).toBe(true)
    removeQuerySessionWork('s');expect(hasPendingQueryWork()).toBe(false)
  })
  it('protects running and unknown sessions, not known idle ones',()=>{
    const entry={connectionId:'c',info:{id:'s',transactionState:'idle' as const,busy:false,canCancel:true,leaseSeconds:1800}}
    updateQuerySessionWork(entry);expect(hasPendingQueryWork()).toBe(false)
    updateQuerySessionWork({...entry,info:{...entry.info,busy:true}});expect(hasPendingQueryWork()).toBe(true)
    updateQuerySessionWork({...entry,info:{...entry.info,transactionState:'unknown'}});expect(hasPendingQueryWork()).toBe(true)
  })
})
