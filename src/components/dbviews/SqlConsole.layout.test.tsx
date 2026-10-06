import {useState} from 'react'
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {EditorView} from '@codemirror/view'
import {SqlConsole} from './SqlConsole'
import {LanguageProvider} from '../../state/LanguageContext'
import {DataProvider} from '../../state/DataContext'
import i18n from '../../i18n'
const api=vi.hoisted(()=>({run:vi.fn(),explain:vi.fn(),split:vi.fn()}))
vi.mock('../../services/db',async original=>({...await original<typeof import('../../services/db')>(),runQuery:api.run,runExplain:api.explain,
  splitQuery:api.split,
  getSchema:vi.fn().mockResolvedValue({db:'c',schemas:[]}),schemaColumnCatalog:vi.fn().mockResolvedValue({tables:[],errors:[],truncated:false}),erRelations:vi.fn().mockResolvedValue([]),
}))
vi.mock('./DataGrid',()=>({DataGrid:()=>{const [count,setCount]=useState(0);return <button data-testid="retained-grid" onClick={()=>setCount(n=>n+1)}>Grid {count}</button>}}))
const mount=()=>render(<LanguageProvider><DataProvider><SqlConsole fresh connId="c" connName="Layout QA" engine="sqlite" initialCode="SELECT 17 AS value"/></DataProvider></LanguageProvider>)
beforeEach(async()=>{localStorage.clear();await i18n.changeLanguage('en');api.split.mockReset().mockImplementation((_c:string,s:string)=>Promise.resolve([s]));api.run.mockReset().mockResolvedValue({columns:[{name:'value',type:'INTEGER'}],rows:[[17]]})})
it('has a persistent output dock before the first execution without inventing data',()=>{
  mount();expect(screen.getByTestId('sql-output-dock')).toBeInTheDocument()
  expect(screen.getByText('Run a query to see results')).toBeInTheDocument()
  expect(screen.getByRole('button',{name:'Execution plan'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'Execution log'}))
  expect(screen.getByText('No execution receipts yet')).toBeInTheDocument()
  expect(api.run).not.toHaveBeenCalled();expect(screen.queryByTestId('retained-grid')).toBeNull()
})
it('switches between data and actual receipts without remounting the grid or replaying SQL',async()=>{
  mount();fireEvent.click(screen.getByTestId('sql-run'));const grid=await screen.findByTestId('retained-grid')
  fireEvent.click(grid);expect(grid).toHaveTextContent('Grid 1')
  fireEvent.click(screen.getByRole('button',{name:'Execution log'}))
  const log=screen.getByTestId('sql-execution-log')
  expect(within(log).getByText('SELECT 17 AS value')).toBeInTheDocument()
  expect(within(log).getByText('Receipt received')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Results'}))
  expect(screen.getByTestId('retained-grid')).toBe(grid);expect(grid).toHaveTextContent('Grid 1');expect(api.run).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTitle('Maximize editor'))
  expect(screen.getByTestId('retained-grid')).toBe(grid)
  fireEvent.click(screen.getByTitle('Restore size'))
  expect(screen.getByTestId('retained-grid')).toBe(grid);expect(grid).toHaveTextContent('Grid 1')
})
it('returns to the chosen statement result when navigating from the execution log',async()=>{
  api.split.mockResolvedValue(['SELECT 17 AS value','SELECT 18 AS value'])
  mount();fireEvent.click(screen.getByTestId('sql-run'));await waitFor(()=>expect(api.run).toHaveBeenCalledTimes(2))
  await screen.findByTestId('retained-grid');fireEvent.click(screen.getByRole('button',{name:'Execution log'}))
  fireEvent.click(screen.getByRole('tab',{name:'Statement 1'}))
  expect(screen.getByRole('button',{name:'Results'})).toHaveAttribute('aria-pressed','true')
  expect(screen.getByTestId('retained-grid')).toBeVisible();expect(api.run).toHaveBeenCalledTimes(2)
})
it('keeps the same editor across layout changes and supports keyboard resizing',()=>{
  const ui=mount(),editor=EditorView.findFromDOM(ui.container.querySelector('.cm-editor')!)!
  expect(screen.getByTestId('sql-query-panes')).toHaveAttribute('data-axis','rows')
  fireEvent.click(screen.getByRole('button',{name:'Side by side'}))
  expect(screen.getByTestId('sql-query-panes')).toHaveAttribute('data-axis','columns')
  const split=screen.getByRole('separator',{name:'Resize editor and results'})
  expect(split).toHaveAttribute('aria-orientation','vertical')
  fireEvent.keyDown(split,{key:'ArrowRight'});expect(Number(split.getAttribute('aria-valuenow'))).toBeGreaterThan(41)
  expect(EditorView.findFromDOM(ui.container.querySelector('.cm-editor')!)).toBe(editor)
  expect(editor.state.doc.toString()).toBe('SELECT 17 AS value')
})
it('hides a pending plan without dropping busy protection or losing the eventual result',async()=>{
  let finish!:(r:unknown)=>void;api.explain.mockReset().mockReturnValue(new Promise(resolve=>{finish=resolve}))
  const ui=mount();fireEvent.click(screen.getByTestId('sql-run'));await screen.findByTestId('retained-grid')
  expect(ui.container.querySelector('.db-output-metrics')).toBeVisible()
  fireEvent.click(screen.getByTestId('sql-explain'));await waitFor(()=>expect(api.explain).toHaveBeenCalledTimes(1))
  expect(ui.container.querySelector('.db-output-metrics')).toBeNull()
  expect(screen.queryByRole('tablist',{name:'Statement results'})).toBeNull()
  fireEvent.click(screen.getByTitle('Close'))
  expect(screen.getByTestId('sql-run')).toBeDisabled()
  expect(screen.getByRole('button',{name:'Execution plan'})).toBeEnabled()
  await act(async()=>finish({columns:[{name:'id',type:'int'},{name:'parent',type:'int'},{name:'notused',type:'int'},{name:'detail',type:'text'}],rows:[[1,0,0,'SCAN CONSTANT ROW']]}))
  await waitFor(()=>expect(screen.getByTestId('sql-run')).toBeEnabled())
  fireEvent.click(screen.getByRole('button',{name:'Execution plan'}));expect(screen.getByText('SCAN CONSTANT ROW')).toBeVisible()
})
it('does not label a pending request as a received receipt',async()=>{
  let finish!:(r:unknown)=>void;api.run.mockReturnValue(new Promise(resolve=>{finish=resolve}))
  mount();fireEvent.click(screen.getByTestId('sql-run'));await waitFor(()=>expect(api.run).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button',{name:'Execution log'}))
  expect(screen.getByTestId('sql-execution-log')).toHaveTextContent('Waiting for the database response')
  expect(screen.queryByText('Receipt received')).toBeNull()
  await act(async()=>finish({columns:[],rows:[],rowsAffected:1}))
  expect(screen.getByTestId('sql-execution-log')).toHaveTextContent('Receipt received')
})
