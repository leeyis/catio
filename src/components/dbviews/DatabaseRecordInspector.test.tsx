import {fireEvent,render,screen,within} from '@testing-library/react'
import {beforeAll,expect,it,vi} from 'vitest'
import i18n from '../../i18n'
import {DatabaseRecordInspector} from './DatabaseRecordInspector'
import type {InspectedDatabaseValue} from './DatabaseValueInspector'
beforeAll(async()=>{await i18n.changeLanguage('en')})
const cell=(label:string,value:unknown,extra:Partial<InspectedDatabaseValue>={}):InspectedDatabaseValue=>({label,value,type:'TEXT',binary:false,binaryKnown:true,...extra})
it('docks typed record fields without conflating NULL, empty strings or BLOB-like text',()=>{
  const inspect=vi.fn()
  render(<DatabaseRecordInspector number={1} cells={[cell('nil',null),cell('empty',''),cell('blob','0x0001',{type:'BLOB',binary:true}),cell('text','0x0001')]} canPrev={false} canNext={false} onPrev={()=>{}} onNext={()=>{}} onClose={()=>{}} onInspect={inspect}/>)
  const pane=screen.getByRole('complementary',{name:'Row detail'})
  expect(pane).toHaveClass('db-record-panel');expect(screen.queryByRole('dialog')).toBeNull()
  expect(within(pane).getByText('Empty string')).toBeInTheDocument()
  expect(within(pane).getAllByText('0x0001')).toHaveLength(2)
  fireEvent.click(within(pane).getAllByTitle('View full content')[2])
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({binary:true,value:'0x0001'}))
})
it('keeps arrow/Escape handling inside the inspector, leaving SQL/editor input alone',()=>{
  const next=vi.fn(),close=vi.fn()
  render(<><input aria-label="Other editor"/><DatabaseRecordInspector number={1} cells={[cell('n',1)]} canPrev={false} canNext onPrev={()=>{}} onNext={next} onClose={close} onInspect={()=>{}}/></>)
  fireEvent.keyDown(screen.getByLabelText('Other editor'),{key:'ArrowDown'});fireEvent.keyDown(document,{key:'Escape'})
  expect(next).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
  const pane=screen.getByRole('complementary')
  fireEvent.keyDown(pane,{key:'ArrowDown'});expect(next).toHaveBeenCalledOnce()
  fireEvent.keyDown(pane,{key:'Escape'});expect(close).toHaveBeenCalledOnce()
})
it('bounds the preview but passes the original value to the full-value inspector',()=>{
  const value='900719925474099312345'.repeat(250),inspect=vi.fn()
  render(<DatabaseRecordInspector number={3} cells={[cell('precise',value)]} canPrev canNext={false} onPrev={()=>{}} onNext={()=>{}} onClose={()=>{}} onInspect={inspect}/>)
  expect(screen.getByText('Preview shortened; open the full value to inspect it.')).toBeInTheDocument()
  fireEvent.click(screen.getByTitle('View full content'));expect(inspect).toHaveBeenCalledWith(expect.objectContaining({value}))
})
