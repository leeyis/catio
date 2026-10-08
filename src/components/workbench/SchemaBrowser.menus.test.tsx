import { render,screen,fireEvent,within } from '@testing-library/react'
import { beforeAll,beforeEach,expect,it,vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SchemaBrowser } from './SchemaBrowser'
import type { SchemaBrowserProps } from './SchemaBrowser'
const ns=[{name:'app',open:false,tables:[{name:'same.name',rows:'',cols:0}],views:[{name:'v_view'}],functions:[{name:'f_total'}]}]
const cb={pick:vi.fn(),object:vi.fn(),query:vi.fn(),er:vi.fn(),compare:vi.fn(),admin:vi.fn(),transfer:vi.fn(),refresh:vi.fn(),create:vi.fn()}
function mount(extra:Partial<SchemaBrowserProps>={}){return render(<LanguageProvider><DataProvider><SchemaBrowser connId="c" schemas={ns} live active={null} onPick={cb.pick} onPickObject={cb.object} onNewQuery={cb.query} onOpenER={cb.er} onObjectAdmin={cb.admin} onTransferData={cb.transfer} onRefresh={cb.refresh} onNewObjectTemplate={cb.create} erActive={false} sqlActive {...extra}/></DataProvider></LanguageProvider>)}
const labels=()=>within(screen.getByRole('menu')).getAllByRole('menuitem').map(b=>b.textContent)
beforeAll(async()=>{await i18n.changeLanguage('en')})
beforeEach(()=>{localStorage.clear();Object.values(cb).forEach(f=>f.mockReset())})
it('puts a labeled new-query action above object search and gates unavailable query capability',()=>{
  const {rerender}=mount();const button=screen.getByTestId('wb-new-query');expect(button).toHaveTextContent('New query');fireEvent.click(button);expect(cb.query).toHaveBeenCalledTimes(1)
  rerender(<LanguageProvider><DataProvider><SchemaBrowser schemas={ns} active={null} onPick={cb.pick} onNewQuery={cb.query} onOpenER={cb.er} erActive={false} sqlActive canSqlConsole={false}/></DataProvider></LanguageProvider>);expect(screen.getByTestId('wb-new-query')).toBeDisabled()
})
it('uses identical schema actions for the ellipsis and context menu',()=>{
  mount();const node=screen.getByTestId('schema-node:app');const trigger=within(node.parentElement!.parentElement!).getByTitle('Schema actions');fireEvent.click(trigger);const expected=labels();fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});fireEvent.contextMenu(node,{clientX:20,clientY:30});expect(labels()).toEqual(expected)
})
it('uses identical table actions from both entrances, preserving the exact dotted target',()=>{
  mount();fireEvent.click(screen.getByTestId('schema-node:app'));const row=screen.getByTestId('schema-tbl:app.same.name');fireEvent.click(screen.getByTestId('leaf-admin-btn:TABLE:same.name'));const expected=labels();fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});fireEvent.contextMenu(row,{clientX:40,clientY:50});expect(labels()).toEqual(expected);fireEvent.click(screen.getByTestId('leaf-admin-item:rename:TABLE:same.name'));expect(cb.admin).toHaveBeenCalledWith('rename','TABLE','app','same.name');expect(cb.pick).not.toHaveBeenCalled()
})
it('hides table-only and unsupported mutations for a view and for readonly tables',()=>{
  mount({canStructureEdit:false});fireEvent.click(screen.getByTestId('schema-node:app'));fireEvent.contextMenu(screen.getByTestId('schema-tbl:app.same.name'));expect(screen.queryByText('Rename')).not.toBeInTheDocument();expect(screen.getByRole('menu')).toHaveTextContent('Copy name');fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});fireEvent.click(screen.getByText('Views'));fireEvent.contextMenu(screen.getByText('v_view'));expect(screen.queryByText('Transfer data')).not.toBeInTheDocument();expect(screen.queryByText('Truncate')).not.toBeInTheDocument()
})
it('exposes compare from both schema entrances, including readonly schemas, but not folder menus',()=>{
  mount({onOpenCompare:cb.compare,canStructureEdit:false})
  const node=screen.getByTestId('schema-node:app'),trigger=within(node.parentElement!.parentElement!).getByTitle('Schema actions')
  fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitem',{name:'Data Compare'}));expect(cb.compare).toHaveBeenCalledTimes(1)
  fireEvent.contextMenu(node);fireEvent.click(screen.getByRole('menuitem',{name:'Data Compare'}));expect(cb.compare).toHaveBeenCalledTimes(2);expect(cb.pick).not.toHaveBeenCalled()
  fireEvent.click(node);fireEvent.click(screen.getByTestId('folder-menu:tables:app'));expect(screen.queryByRole('menuitem',{name:'Data Compare'})).toBeNull()
})
it.each([{live:false},{canSqlConsole:false},{onOpenCompare:undefined}])('keeps unavailable compare out of schema menus: %j',extra=>{
  mount({onOpenCompare:cb.compare,...extra});fireEvent.contextMenu(screen.getByTestId('schema-node:app'))
  expect(screen.queryByRole('menuitem',{name:'Data Compare'})).toBeNull();expect(cb.compare).not.toHaveBeenCalled()
})
it('does not offer a view-creation action when views are unsupported',()=>{
  mount({canViews:false});fireEvent.contextMenu(screen.getByTestId('schema-node:app'));expect(screen.queryByRole('menuitem',{name:'New view'})).not.toBeInTheDocument()
})
