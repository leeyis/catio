import {useState} from 'react'
import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeAll,beforeEach,expect,it,vi} from 'vitest'
import {DbWorkbench,tabIdOf} from './DbWorkbench'
import {useReportDatabaseWork} from '../../state/databaseDraftWork'
import {LanguageProvider} from '../../state/LanguageContext'
import {DataProvider} from '../../state/DataContext'
import {DATA} from '../../services/mockData'
import i18n from '../../i18n'
vi.mock('../../state/dbConnections',async original=>({...await original<typeof import('../../state/dbConnections')>(),listActiveDbConnections:()=>[]}))
vi.mock('./TablePane',()=>({TablePane:()=>{const [dirty,setDirty]=useState(false);useReportDatabaseWork('grid',dirty);return <button onClick={()=>setDirty(true)}>Edit fixture</button>}}))
const mount=()=>render(<LanguageProvider><DataProvider><DbWorkbench conn={DATA.byId['d-orders']} workspaceTabId="preview-test"/></DataProvider></LanguageProvider>)
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{localStorage.clear()})
const expand=()=>fireEvent.click(screen.getByTestId('schema-node:public'))
it('replaces only the temporary preview and preserves pinned tabs',()=>{mount();expand();fireEvent.click(screen.getByTestId('schema-tbl:public.customers'));expect(screen.getByTestId('wbtab-pin-table:public.customers')).toBeInTheDocument();fireEvent.click(screen.getByTestId('schema-tbl:public.line_items'));expect(screen.queryByTestId('wbtab-table:public.customers')).toBeNull();expect(screen.getByTestId('wbtab-table:public.orders')).toBeInTheDocument();fireEvent.click(screen.getByTestId('wbtab-pin-table:public.line_items'));fireEvent.click(screen.getByTestId('schema-tbl:public.customers'));expect(screen.getByTestId('wbtab-table:public.line_items')).toBeInTheDocument()})
it('double-click pins the same object instead of creating a duplicate tab',()=>{mount();expand();fireEvent.click(screen.getByTestId('schema-tbl:public.customers'));fireEvent.doubleClick(screen.getByTestId('schema-tbl:public.customers'));expect(screen.queryByTestId('wbtab-pin-table:public.customers')).toBeNull();expect(screen.getAllByTestId('wbtab-table:public.customers')).toHaveLength(1)})
it('automatically pins a dirty preview and protects close until explicitly discarded',async()=>{mount();expand();fireEvent.click(screen.getByTestId('schema-tbl:public.customers'));const buttons=screen.getAllByText('Edit fixture');fireEvent.click(buttons[buttons.length-1]);await waitFor(()=>expect(screen.queryByTestId('wbtab-pin-table:public.customers')).toBeNull());fireEvent.click(screen.getByTestId('wbtab-close-table:public.customers'));expect(screen.getByText('Close database work?')).toBeInTheDocument();fireEvent.click(screen.getByText('Keep working'));expect(screen.getByTestId('wbtab-table:public.customers')).toBeInTheDocument();fireEvent.click(screen.getByTestId('wbtab-close-table:public.customers'));fireEvent.click(screen.getByText('Discard drafts and close'));expect(screen.queryByTestId('wbtab-table:public.customers')).toBeNull()})
it('navigates document tabs with arrow keys without closing or replacing previews',()=>{
  mount();expand();fireEvent.click(screen.getByTestId('schema-tbl:public.customers'))
  const current=screen.getByTestId('wbtab-table:public.customers'),first=screen.getByTestId('wbtab-table:public.orders')
  expect(current).toHaveAttribute('aria-selected','true')
  fireEvent.keyDown(current,{key:'ArrowLeft'})
  expect(first).toHaveAttribute('aria-selected','true');expect(first).toHaveFocus()
  expect(current).toBeInTheDocument()
  fireEvent.keyDown(first,{key:'End'});expect(current).toHaveAttribute('aria-selected','true')
})
it('opens the same command palette from the explorer caption and keyboard without touching tabs',()=>{
  const ui=mount(),tabs=screen.getAllByRole('tab').map(tab=>tab.textContent)
  expect(screen.queryByRole('button',{name:'Database tools'})).toBeNull()
  const entry=screen.getByRole('button',{name:'Database commands'})
  entry.focus();fireEvent.click(entry);expect(screen.getByRole('dialog',{name:'Database commands'})).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(entry).toHaveFocus()
  fireEvent.keyDown(ui.container.querySelector('.db-workbench')!,{key:'P',ctrlKey:true,shiftKey:true});expect(screen.getByRole('dialog',{name:'Database commands'})).toBeInTheDocument()
  expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(tabs)
})
it('keeps dotted, percent and same-named namespace tuples distinct',()=>{expect(tabIdOf.table('a.b','c')).not.toBe(tabIdOf.table('a','b.c'));expect(tabIdOf.table('a','%2E')).not.toBe(tabIdOf.table('a','.'));expect(tabIdOf.object('view','a.b','c')).not.toBe(tabIdOf.object('view','a','b.c'))})
