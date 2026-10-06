import {act,render,waitFor} from '@testing-library/react'
import {beforeEach,expect,it} from 'vitest'
import {EditorView} from '@codemirror/view'
import {ensureSyntaxTree} from '@codemirror/language'
import {diagnosticCount,forceLinting,forEachDiagnostic} from '@codemirror/lint'
import {undoDepth} from '@codemirror/commands'
import {SqlEditor} from './SqlEditor'
import {sqlLinter} from './sqlDiagnostics'
import i18n from '../../i18n'
beforeEach(async()=>{await i18n.changeLanguage('en')})
const source=(tables:string[])=>sqlLinter(()=>({defaultSchema:'app',namespaces:[{name:'app',status:'loaded',tables:tables.map(name=>({name})),views:[]}]}),{engine:'postgres'})
it('refreshes real gutter diagnostics after metadata changes without editing or losing undo/selection',async()=>{
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
