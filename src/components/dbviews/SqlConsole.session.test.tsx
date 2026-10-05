import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SqlConsole } from './SqlConsole'
import type { QuerySessionInfo } from '../../services/db'
import type { DataGridProps } from './DataGrid'
import { DatabaseWorkProvider,hasBusyDatabaseDraftWork } from '../../state/databaseDraftWork'
import { listQuerySessionWork,removeQuerySessionWork } from '../../state/querySessionWork'
const api=vi.hoisted(()=>({openQuerySession:vi.fn(),closeQuerySession:vi.fn(),querySessionStatus:vi.fn(),pingQuerySession:vi.fn(),querySessionTransaction:vi.fn(),runQuery:vi.fn(),cancelQuery:vi.fn(),grid:null as DataGridProps|null}))
vi.mock('../../services/db',async original=>({...await original<typeof import('../../services/db')>(),...api,
  splitQuery:vi.fn().mockImplementation((_c:string,s:string)=>Promise.resolve([s])),
  getSchema:vi.fn().mockResolvedValue({db:'c',schemas:[]}),schemaColumns:vi.fn().mockResolvedValue([]),erRelations:vi.fn().mockResolvedValue([])}))
// Exercise the real CodeMirror current-statement seam with the isolated-session backend mock.
vi.mock('./DataGrid',()=>({DataGrid:(props:DataGridProps)=>{api.grid=props;return <div data-testid="session-result"/>}}))
const info=(id='sql-a',transactionState:QuerySessionInfo['transactionState']='idle'):QuerySessionInfo=>({id,transactionState,busy:false,canCancel:true,leaseSeconds:1800})
const wrap=()=>render(<LanguageProvider><DataProvider><DatabaseWorkProvider owner={{ownerId:'inner',workbenchId:'outer',profileId:'profile'}}><SqlConsole fresh connId="c" engine="sqlite" querySessions
  profileId="profile" workbenchId="outer" sessionOwnerId="inner" initialCode="SELECT 1"/></DatabaseWorkProvider></DataProvider></LanguageProvider>)
beforeEach(async()=>{
  localStorage.clear();for(const [key,value] of Object.entries(api))if(key!=='grid')(value as ReturnType<typeof vi.fn>).mockReset()
  listQuerySessionWork().forEach(item=>removeQuerySessionWork(item.info.id));api.grid=null
  await i18n.changeLanguage('en')
  api.openQuerySession.mockResolvedValue(info());api.closeQuerySession.mockResolvedValue(undefined)
  api.querySessionStatus.mockResolvedValue(info());api.pingQuerySession.mockResolvedValue(undefined)
  api.runQuery.mockResolvedValue({columns:[{name:'n',type:'int'}],rows:[[1]]})
})
describe('isolated SQL sessions',()=>{
  it('holds the draft close guard while a transaction action is awaiting its real receipt',async()=>{
    let finish!:(value:QuerySessionInfo)=>void
    api.querySessionTransaction.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    wrap();await waitFor(()=>expect(screen.getByRole('button',{name:'Begin transaction'})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:'Begin transaction'}))
    await waitFor(()=>expect(api.querySessionTransaction).toHaveBeenCalledTimes(1))
    expect(hasBusyDatabaseDraftWork({ownerId:'inner'})).toBe(true)
    api.querySessionStatus.mockResolvedValue(info('sql-a','active'))
    await act(async()=>{finish(info('sql-a','active'))})
    await waitFor(()=>expect(hasBusyDatabaseDraftWork({ownerId:'inner'})).toBe(false))
  })
  it('binds execution, results and paging to its session ID and closes on unmount',async()=>{
    const view=wrap();await waitFor(()=>expect(api.openQuerySession).toHaveBeenCalledWith('c'))
    await screen.findByRole('button',{name:'Begin transaction'})
    fireEvent.click(screen.getByTestId('sql-run'))
    await screen.findByTestId('session-result')
    expect(api.runQuery.mock.calls[0][5]).toEqual(expect.objectContaining({querySessionId:'sql-a'}))
    expect(api.grid?.querySessionId).toBe('sql-a')
    view.unmount();await waitFor(()=>expect(api.closeQuerySession).toHaveBeenCalledWith('c','sql-a'))
    expect(listQuerySessionWork()).toHaveLength(0)
  })
  it('shows observed transaction state and issues explicit rollback',async()=>{
    api.querySessionTransaction.mockResolvedValueOnce(info('sql-a','active')).mockResolvedValueOnce(info())
    wrap();await screen.findByRole('button',{name:'Begin transaction'})
    api.querySessionStatus.mockResolvedValue(info('sql-a','active'))
    fireEvent.click(screen.getByRole('button',{name:'Begin transaction'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Commit transaction'})).toBeEnabled())
    expect(api.querySessionTransaction).toHaveBeenCalledWith('c','sql-a','begin')
    expect(listQuerySessionWork()[0].info.transactionState).toBe('active')
    api.querySessionStatus.mockResolvedValue(info())
    fireEvent.click(screen.getByRole('button',{name:'Roll back transaction'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Begin transaction'})).toBeEnabled())
    expect(api.querySessionTransaction).toHaveBeenCalledWith('c','sql-a','rollback')
  })
  it('closes an opening session that arrives after its owner unmounts',async()=>{
    let resolve!:(value:QuerySessionInfo)=>void
    api.openQuerySession.mockReturnValue(new Promise(ok=>{resolve=ok}))
    const view=wrap();view.unmount()
    await act(async()=>{resolve(info('late-session'))})
    await waitFor(()=>expect(api.closeQuerySession).toHaveBeenCalledWith('c','late-session'))
    expect(listQuerySessionWork()).toHaveLength(0)
  })
})
