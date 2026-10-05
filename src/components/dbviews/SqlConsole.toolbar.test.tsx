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
  useImperativeHandle(ref,()=>({getSelectedText:()=>api.selected,insertAtCursor:(s:string)=>s}))
  return <><div data-testid="editor-text">{props.code}</div><button onClick={()=>{api.selected='SELECT 2';props.onSelectionChange?.(true)}}>Choose fragment</button><button onClick={()=>{api.selected='';props.onSelectionChange?.(false)}}>Clear selection</button></>
})}))
vi.mock('./DataGrid',()=>({DataGrid:()=> <div data-testid="grid"/>}))
const mount=()=>render(<LanguageProvider><DataProvider><SqlConsole fresh connId="c" connName="Reporting" engine="postgres" initialCode="SELECT 1; SELECT 2;"/></DataProvider></LanguageProvider>)
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{localStorage.clear();api.selected='';api.run.mockReset().mockResolvedValue({columns:[],rows:[]});api.split.mockReset().mockImplementation((_c:string,s:string)=>Promise.resolve([s]))})
it('shows the actual target and discoverable action labels, not only icons',()=>{
  mount();expect(screen.getByTestId('sql-query-target')).toHaveTextContent('Reporting')
  expect(screen.getByRole('button',{name:'Run SQL Alt↵'})).toBeInTheDocument()
  expect(screen.getByRole('button',{name:'Run selection'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'Analyze'})).toBeInTheDocument()
  expect(screen.getByRole('button',{name:'Format'})).toBeInTheDocument()
})
it('runs only the live selected fragment from the explicit selection button',async()=>{
  mount();fireEvent.click(screen.getByText('Choose fragment'));const action=screen.getByRole('button',{name:'Run selection'});expect(action).toBeEnabled();fireEvent.click(action)
  await waitFor(()=>expect(api.split).toHaveBeenCalledWith('c','SELECT 2'));expect(api.run.mock.calls[0][1]).toBe('SELECT 2')
})
it('does not fall back to the document after a selection disappears',()=>{
  mount();fireEvent.click(screen.getByText('Choose fragment'));fireEvent.click(screen.getByText('Clear selection'));const button=screen.getByRole('button',{name:'Run selection'});expect(button).toBeDisabled();fireEvent.click(button);expect(api.split).not.toHaveBeenCalled()
})
it('groups file and clear actions in a keyboard dismissible menu',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'More actions'}));expect(screen.getByRole('menu')).toBeInTheDocument();expect(screen.getByRole('menuitem',{name:'Run SQL file'})).toBeInTheDocument();fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
it('requires confirmation before clearing a nonempty editor',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'More actions'}));fireEvent.click(screen.getByRole('menuitem',{name:'Clear editor'}));expect(screen.getByTestId('editor-text')).toHaveTextContent('SELECT 1')
  fireEvent.click(screen.getByRole('button',{name:'Keep SQL'}));expect(screen.getByTestId('editor-text')).toHaveTextContent('SELECT 1')
  fireEvent.click(screen.getByRole('button',{name:'More actions'}));fireEvent.click(screen.getByRole('menuitem',{name:'Clear editor'}));fireEvent.click(screen.getByRole('button',{name:'Clear editor'}));expect(screen.getByTestId('editor-text')).toHaveTextContent('')
})
