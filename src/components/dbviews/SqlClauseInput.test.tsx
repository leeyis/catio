import {afterEach,describe,it,expect,vi} from 'vitest'
import {useState} from 'react'
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react'
import {LanguageProvider} from '../../state/LanguageContext'
import {SqlClauseInput} from './SqlClauseInput'
afterEach(()=>{cleanup();vi.restoreAllMocks()})
function setup(){
 const submit=vi.fn()
 function Ui(){const [value,setValue]=useState('');return <LanguageProvider><SqlClauseInput mode="where" value={value} onChange={setValue} columns={['status','status_note','name']} engine="postgres" onSubmit={submit}/></LanguageProvider>}
 render(<Ui/>);const input=screen.getByRole('combobox') as HTMLInputElement;act(()=>input.focus());return {input,submit}
}
function change(input:HTMLInputElement,value:string){fireEvent.change(input,{target:{value}})}
describe('clause input editing, not execution',()=>{
 it('accepts with arrows/Enter and only a later Enter submits',()=>{
  const {input,submit}=setup();change(input,'sta');expect(screen.getAllByRole('option')).toHaveLength(2)
  fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'Enter'})
  expect(input.value).toBe('"status_note"');expect(submit).not.toHaveBeenCalled();expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.keyDown(input,{key:'Enter'});expect(submit).toHaveBeenCalledTimes(1)
 })
 it('Tab accepts, Escape dismisses, and empty focus does not open',()=>{
  const {input,submit}=setup();fireEvent.focus(input);expect(screen.queryByRole('listbox')).toBeNull()
  change(input,'name li');expect(screen.getByRole('option',{name:'LIKE'})).toBeInTheDocument()
  fireEvent.keyDown(input,{key:'Tab'});expect(input.value).toBe('name LIKE');expect(submit).not.toHaveBeenCalled()
  change(input,'sta');fireEvent.keyDown(input,{key:'Escape'});expect(screen.queryByRole('listbox')).toBeNull()
 })
 it('composition confirmation never accepts a candidate or submits',()=>{
  const {input,submit}=setup();change(input,'sta');fireEvent.compositionStart(input)
  fireEvent.keyDown(input,{key:'Enter'});expect(input.value).toBe('sta');expect(submit).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input);fireEvent.keyDown(input,{key:'Enter',keyCode:229});expect(submit).not.toHaveBeenCalled();expect(input.value).toBe('sta')
 })
 it('mouse acceptance does not submit and blur clears the menu',()=>{
  const {input,submit}=setup();change(input,'sta');fireEvent.mouseDown(screen.getByRole('option',{name:'status'}));fireEvent.mouseUp(input)
  expect(input.value).toBe('"status"');expect(submit).not.toHaveBeenCalled()
  change(input,'name li');fireEvent.blur(input);expect(screen.queryByRole('listbox')).toBeNull()
 })
 it('recomputes at a moved caret and replaces the middle token suffix',()=>{
  const {input,submit}=setup();change(input,'statux = 1');act(()=>input.setSelectionRange(3,3));fireEvent.select(input)
  expect(input.selectionStart).toBe(3);expect(screen.getByRole('option',{name:'status'})).toBeInTheDocument()
  fireEvent.keyDown(input,{key:'Enter'});expect(input.value).toBe('"status" = 1');expect(submit).not.toHaveBeenCalled()
 })
 it('blocks submission while the owning grid is busy',()=>{
  const submit=vi.fn();render(<LanguageProvider><SqlClauseInput mode="where" value="id = 1" onChange={()=>{}} columns={['id']} onSubmit={submit} submitDisabled/></LanguageProvider>)
  fireEvent.keyDown(screen.getByRole('combobox'),{key:'Enter'});expect(submit).not.toHaveBeenCalled()
 })
 it('clears candidates when metadata or dialect changes without changing the draft',()=>{
  const change=vi.fn(),submit=vi.fn(),ui=(columns:string[],engine:string)=><LanguageProvider><SqlClauseInput mode="where" value="sta" onChange={change} columns={columns} engine={engine} onSubmit={submit}/></LanguageProvider>
  const {rerender}=render(ui(['status'],'postgres'));fireEvent.focus(screen.getByRole('combobox'));expect(screen.getByRole('option',{name:'status'})).toBeInTheDocument()
  rerender(ui(['score'],'sqlite'));expect(screen.queryByRole('listbox')).toBeNull();expect(change).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled()
 })
 it('does not show columns inside text/values or replace a selected range',()=>{
  const {input}=setup();change(input,"name = 'sta");expect(screen.queryByRole('listbox')).toBeNull()
  change(input,'name = sta');expect(screen.queryByRole('listbox')).toBeNull()
  change(input,'sta');act(()=>input.setSelectionRange(0,3));fireEvent.select(input);expect(screen.queryByRole('listbox')).toBeNull()
 })
})
