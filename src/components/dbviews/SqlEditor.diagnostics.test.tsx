import {act,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {EditorView} from '@codemirror/view'
import {ensureSyntaxTree} from '@codemirror/language'
import {diagnosticCount,forceLinting,forEachDiagnostic,openLintPanel} from '@codemirror/lint'
import {undo,undoDepth} from '@codemirror/commands'
import {SqlEditor} from './SqlEditor'
import {sqlLinter} from './sqlDiagnostics'
import i18n from '../../i18n'
beforeEach(async()=>{localStorage.clear();await i18n.changeLanguage('en')})
const source=(tables:string[])=>sqlLinter(()=>({defaultSchema:'app',namespaces:[{name:'app',status:'loaded',tables:tables.map(name=>({name})),views:[]}]}),{engine:'postgres'})
it('uses compact inline diagnostics with an explicit, undoable repair instead of a separate SQL gutter',async()=>{
  const onRun=vi.fn(),code='SELECT * FROM zebra_export LIMIT 100；'
  const {container}=render(<SqlEditor code={code} onChange={()=>{}} onRun={onRun} engine="sqlite" lintSource={sqlLinter(()=>({tables:['zebra_export']}),{engine:'sqlite'})}/>)
  const view=EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  ensureSyntaxTree(view.state,view.state.doc.length,100)
  act(()=>forceLinting(view))
  await waitFor(()=>expect(diagnosticCount(view.state)).toBe(1))
  expect(container.querySelector('.cm-gutter-lint')).toBeNull()
  expect(container.querySelector('.cm-lintRange-warning')).toHaveTextContent('；')
  expect(getComputedStyle(view.contentDOM).paddingLeft).toBe('4px')
  act(()=>{openLintPanel(view)})
  expect(screen.getByRole('listbox',{name:'Local SQL hints'})).toBeInTheDocument()
  expect(getComputedStyle(container.querySelector('.cm-panel-lint [name="close"]')!).width).toBe('20px')
  fireEvent.click(screen.getByRole('button',{name:/Replace with ;/}))
  expect(view.state.doc.toString()).toBe('SELECT * FROM zebra_export LIMIT 100;')
  expect(onRun).not.toHaveBeenCalled()
  act(()=>{undo(view)})
  expect(view.state.doc.toString()).toBe(code)
})
it('retains the existing plain-mode diagnostic gutter',()=>{
  const {container}=render(<SqlEditor plain code="GET" onChange={()=>{}} lintSource={()=>[{from:0,to:3,severity:'error',message:'Key required'}]}/>)
  expect(container.querySelector('.cm-gutter-lint')).not.toBeNull()
})
it('refreshes inline diagnostics after metadata changes without editing or losing undo/selection',async()=>{
  const code='SELECT * FROM missing;'
  const {container,rerender}=render(<SqlEditor code={code} onChange={()=>{}} engine="postgres" lintSource={source([])}/>)
  const view=EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  expect(ensureSyntaxTree(view.state,view.state.doc.length,100)).not.toBeNull()
  act(()=>forceLinting(view))
  await waitFor(()=>expect(diagnosticCount(view.state)).toBe(1))
  let details:{from:number;to:number;message:string}[]=[]
  forEachDiagnostic(view.state,(d,from,to)=>details.push({from,to,message:d.message}))
  expect(details).toEqual([expect.objectContaining({from:14,to:21,message:expect.stringContaining('not found in the loaded catalog')})])
  act(()=>view.dispatch({changes:{from:view.state.doc.length,insert:' '},selection:{anchor:7}}))
  const before={text:view.state.doc.toString(),selection:view.state.selection.main,undo:undoDepth(view.state)}
  rerender(<SqlEditor code={code} onChange={()=>{}} engine="postgres" lintSource={source(['missing'])}/>)
  act(()=>forceLinting(view))
  await waitFor(()=>expect(diagnosticCount(view.state)).toBe(0))
  expect({text:view.state.doc.toString(),selection:view.state.selection.main,undo:undoDepth(view.state)}).toEqual(before)
  details=[]
  forEachDiagnostic(view.state,(d,from,to)=>details.push({from,to,message:d.message}))
  expect(details).toEqual([])
})
