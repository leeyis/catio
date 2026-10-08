import { EditorState } from '@codemirror/state'
import { sql } from '@codemirror/lang-sql'
import { sqlExecutionTarget } from './sqlExecutionTarget'
import { forwardRef, useImperativeHandle } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { SqlConsole } from './SqlConsole'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'

const api=vi.hoisted(()=>({selected:'',run:vi.fn(),split:vi.fn()}))
vi.mock('../../services/db',async original=>({
  ...await original<typeof import('../../services/db')>(),
  runQuery:api.run,splitQuery:api.split,
  getSchema:vi.fn().mockResolvedValue({db:'c',defaultNamespace:'public',schemas:[{name:'public',tables:[],views:[],functions:[]}]}),
  schemaColumnCatalog:vi.fn().mockResolvedValue({tables:[],errors:[],truncated:false}),
  erRelations:vi.fn().mockResolvedValue([]),
}))
vi.mock('./SqlEditor',()=>({SqlEditor:forwardRef((props:{code:string;onSelectionChange?:(hasSelection:boolean)=>void},ref)=>{
  useImperativeHandle(ref,()=>({getExecutionTarget:(scope:'current'|'selection'|'all')=>scope==='selection'?(api.selected?{target:{sql:api.selected,from:0,to:api.selected.length,kind:'selection'}}:{target:null,reason:'empty'}):sqlExecutionTarget(EditorState.create({doc:props.code,extensions:[sql()]}),scope),getSelectedText:()=>api.selected,insertAtCursor:(s:string)=>s}))
  return <><div data-testid="editor-text">{props.code}</div><button onClick={()=>{api.selected='SELECT 2';props.onSelectionChange?.(true)}}>Choose fragment</button><button onClick={()=>{api.selected='';props.onSelectionChange?.(false)}}>Clear selection</button></>
})}))
vi.mock('./DataGrid',()=>({DataGrid:()=> <div data-testid="grid"/>}))
const mount=()=>render(<LanguageProvider><DataProvider><SqlConsole fresh connId="c" connName="Reporting" engine="postgres" initialCode="SELECT 1; SELECT 2;"/></DataProvider></LanguageProvider>)
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{localStorage.clear();api.selected='';api.run.mockReset().mockResolvedValue({columns:[],rows:[]});api.split.mockReset().mockImplementation((_c:string,s:string)=>Promise.resolve([s]))})
it('shows the actual target and discoverable action labels, not only icons',()=>{
  mount();expect(screen.getByTestId('sql-query-target')).toHaveTextContent('Reporting')
  expect(screen.getByRole('button',{name:'Run current statement Alt↵'})).toBeInTheDocument()
  expect(screen.queryByRole('button',{name:'Run selection'})).toBeNull()
  expect(screen.getByRole('button',{name:'Analyze'})).toBeInTheDocument()
  expect(screen.getByRole('button',{name:'Format'})).toBeInTheDocument()
})
it('runs only the live selected fragment from the explicit selection button',async()=>{
  mount();fireEvent.click(screen.getByText('Choose fragment'));const action=screen.getByRole('button',{name:'Run selection Alt↵'});expect(action).toBeEnabled();fireEvent.click(action)
  await waitFor(()=>expect(api.split).toHaveBeenCalledWith('c','SELECT 2'));expect(api.run.mock.calls[0][1]).toBe('SELECT 2')
})
it('does not fall back to the document after a selection disappears',()=>{
  mount();fireEvent.click(screen.getByText('Choose fragment'));api.selected='' // Live selection disappeared before its UI notification.
  fireEvent.click(screen.getByRole('button',{name:'Run selection Alt↵'}));expect(api.split).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Clear selection'));expect(screen.getByRole('button',{name:'Run current statement Alt↵'})).toBeInTheDocument()
})
it.each(['mongodb','redis','elasticsearch'])('does not advertise SQL-file execution for the %s native console',engine=>{
  render(<LanguageProvider><DataProvider><SqlConsole fresh connId="native" connName="Native QA" engine={engine}/></DataProvider></LanguageProvider>)
  fireEvent.click(screen.getByRole('button',{name:'More actions'}));expect(screen.queryByRole('menuitem',{name:'Run SQL file'})).toBeNull()
})
it('keeps script execution only in Run options, not duplicated in More actions',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'More actions'}));expect(screen.queryByRole('menuitem',{name:'Run entire script'})).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'})
  fireEvent.click(screen.getByRole('button',{name:'Run options'}));expect(screen.getByRole('menuitem',{name:'Run entire script'})).toBeInTheDocument()
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
})
it('only opens the run dropdown on pointer interaction and restores focus on Escape',()=>{
  mount();const trigger=screen.getByRole('button',{name:'Run options'})
  fireEvent.mouseEnter(trigger);fireEvent.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded','true');expect(screen.getByRole('menuitem',{name:'Run entire script'})).toHaveFocus()
  expect(api.run).not.toHaveBeenCalled();expect(api.split).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});expect(trigger).toHaveFocus();expect(trigger).toHaveAttribute('aria-expanded','false')
})
it('groups file and clear actions in a keyboard dismissible menu',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'More actions'}));expect(screen.getByRole('menu')).toBeInTheDocument();expect(screen.getByRole('menuitem',{name:'Run SQL file'})).toBeInTheDocument();fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
it('requires confirmation before clearing a nonempty editor',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'More actions'}));fireEvent.click(screen.getByRole('menuitem',{name:'Clear editor'}));expect(screen.getByTestId('editor-text')).toHaveTextContent('SELECT 1')
  fireEvent.click(screen.getByRole('button',{name:'Keep SQL'}));expect(screen.getByTestId('editor-text')).toHaveTextContent('SELECT 1')
  fireEvent.click(screen.getByRole('button',{name:'More actions'}));fireEvent.click(screen.getByRole('menuitem',{name:'Clear editor'}));fireEvent.click(screen.getByRole('button',{name:'Clear editor'}));expect(screen.getByTestId('editor-text')).toHaveTextContent('')
})

it('runs the caret statement by default and the whole script only from its explicit action',async()=>{mount();fireEvent.click(screen.getByTestId('sql-run'));await waitFor(()=>expect(api.split).toHaveBeenCalledWith('c','SELECT 1;'));await waitFor(()=>expect(screen.getByTestId('sql-run')).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Run options'}));fireEvent.click(screen.getByRole('menuitem',{name:'Run entire script'}));await waitFor(()=>expect(api.split).toHaveBeenLastCalledWith('c','SELECT 1; SELECT 2;'))})
