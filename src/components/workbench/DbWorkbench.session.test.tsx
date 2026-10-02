import {act,fireEvent,render,screen} from '@testing-library/react'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {LanguageProvider} from '../../state/LanguageContext'
import {DataProvider} from '../../state/DataContext'
import {DATA} from '../../services/mockData'
import i18n from '../../i18n'
import {DbWorkbench} from './DbWorkbench'
import {listQuerySessionWork,removeQuerySessionWork,updateQuerySessionWork} from '../../state/querySessionWork'
vi.mock('../dbviews',()=>({SqlConsole:()=> <div>query pane</div>,ERDiagram:()=> <div/>}))
vi.mock('./TablePane',()=>({TablePane:()=> <div/>}))
vi.mock('./SchemaBrowser',()=>({SchemaBrowser:({onNewQuery}:{onNewQuery:()=>void})=><button onClick={()=>onNewQuery()}>new query</button>}))
beforeEach(async()=>{localStorage.clear();listQuerySessionWork().forEach(x=>removeQuerySessionWork(x.info.id));await i18n.changeLanguage('en')})
function setup(){
  const view=render(<LanguageProvider><DataProvider><DbWorkbench conn={DATA.byId['d-orders']} workspaceTabId="outer"/></DataProvider></LanguageProvider>)
  fireEvent.click(screen.getByText('new query'))
  act(()=>updateQuerySessionWork({connectionId:'c',profileId:'d-orders',workbenchId:'outer',ownerId:'outer:sql:1',
    info:{id:'sql-lease',transactionState:'active',busy:false,canCancel:true,leaseSeconds:1800}}))
  return view
}
describe('query-tab close protection',()=>{
  it('keeps an uncommitted tab open when closure is cancelled',()=>{
    setup();fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    expect(screen.getByText('Close SQL session?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}))
    expect(screen.getByTestId('wbtab-sql:1')).toBeInTheDocument()
  })
  it('closes only after explicit rollback confirmation',()=>{
    setup();fireEvent.click(screen.getByTestId('wbtab-close-sql:1'))
    fireEvent.click(screen.getByRole('button',{name:'Close and roll back'}))
    expect(screen.queryByTestId('wbtab-sql:1')).not.toBeInTheDocument()
  })
})
