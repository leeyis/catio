import {render,screen,fireEvent} from '@testing-library/react'
import {beforeEach,it,expect,vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import {DataProvider} from '../../state/DataContext'
import {DATA} from '../../services/mockData'
import {DbWorkbench} from '../workbench/DbWorkbench'
import {SchemaBrowser} from '../workbench/SchemaBrowser'
import {QuerySessionToolbar} from './QuerySessionToolbar'
import i18n from '../../i18n'
vi.mock('../../state/dbConnections',async original=>({...await original<typeof import('../../state/dbConnections')>(),listActiveDbConnections:()=>[]}))
vi.mock('../workbench/TablePane',()=>({TablePane:()=> <div>Table fixture</div>}))
beforeEach(async()=>{localStorage.clear();await i18n.changeLanguage('en')})
it('has one visible New query action and no redundant workspace action strip',()=>{
  const ui=render(<LanguageProvider><DataProvider><DbWorkbench conn={DATA.byId['d-orders']}/></DataProvider></LanguageProvider>)
  expect(screen.getAllByText('New query')).toHaveLength(1)
  expect(ui.container.querySelector('.db-workspace-chrome')).toBeNull()
  expect(screen.queryByRole('button',{name:'Database commands'})).toBeNull()
  expect(screen.queryByRole('button',{name:'ER diagram'})).toBeNull()
})
it('owns Compare/ER/command navigation in one database tools menu',()=>{
  const compare=vi.fn(),er=vi.fn(),commands=vi.fn()
  render(<LanguageProvider><DataProvider><SchemaBrowser onPick={()=>{}} active={null} onNewQuery={()=>{}} onOpenER={er} onOpenCompare={compare} onOpenCommands={commands} erActive={false} sqlActive={false} live schemas={[]} conn={DATA.byId['d-orders']}/></DataProvider></LanguageProvider>)
  expect(screen.queryByRole('button',{name:'Data Compare'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'Database tools'}))
  expect(screen.getByRole('menuitem',{name:'Database commands'})).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem',{name:'Data Compare'}));expect(compare).toHaveBeenCalledOnce()
})
it('shows one transaction control while retaining capability and owner gating in its menu',()=>{
  const action=vi.fn(),info={id:'session-a',transactionState:'idle' as const,busy:false,canCancel:true,supportsTransactions:true,leaseSeconds:1800}
  const {rerender}=render(<QuerySessionToolbar ownerKey="tab-a" info={info} loading={false} busy={false} error={null} onAction={action} onReconnect={()=>{}}/>)
  expect(screen.queryByRole('button',{name:'Begin transaction'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'Transaction actions'}))
  expect(screen.getByRole('menuitem',{name:'Begin transaction'})).toBeEnabled()
  expect(screen.getByRole('menuitem',{name:'Commit transaction'})).toBeDisabled()
  rerender(<QuerySessionToolbar ownerKey="tab-b" info={info} loading={false} busy={false} error={null} onAction={action} onReconnect={()=>{}}/>)
  expect(screen.queryByRole('menu')).toBeNull();expect(action).not.toHaveBeenCalled()
})
