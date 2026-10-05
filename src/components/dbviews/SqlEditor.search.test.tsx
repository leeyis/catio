import {createRef} from 'react'
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it} from 'vitest'
import {EditorView} from '@codemirror/view'
import {undoDepth} from '@codemirror/commands'
import {SqlEditor,type SqlEditorHandle} from './SqlEditor'
import i18n from '../../i18n'
afterEach(async()=>{await i18n.changeLanguage('en')})
it('localizes live search without losing the document, query or undo history',async()=>{
  await i18n.changeLanguage('en')
  const ref=createRef<SqlEditorHandle>()
  const {container}=render(<SqlEditor ref={ref} code="SELECT 1; SELECT 2;" onChange={()=>{}} engine="sqlite"/>)
  const editor=EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  act(()=>{editor.dispatch({changes:{from:editor.state.doc.length,insert:' '}});ref.current?.openSearch()})
  fireEvent.change(screen.getByLabelText('Find'),{target:{value:'SELECT'}})
  const before={text:editor.state.doc.toString(),undo:undoDepth(editor.state)}
  await act(async()=>{await i18n.changeLanguage('zh')})
  await waitFor(()=>expect(screen.getByLabelText('查找')).toHaveValue('SELECT'))
  expect(screen.getByRole('button',{name:'全部替换'})).toBeInTheDocument()
  expect({text:editor.state.doc.toString(),undo:undoDepth(editor.state)}).toEqual(before)
})
