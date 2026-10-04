import { act, fireEvent, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { expect, it } from 'vitest'
import { SqlEditor } from './SqlEditor'
import { sqlAdvancedCompletion } from './sqlAdvancedCompletion'
import '../../i18n'
function insert(name: string, engine = 'sqlite') {
  const code = 'SELECT ' + name
  const source = sqlAdvancedCompletion(() => engine, () => [])
  const rendered = render(<SqlEditor code={code} onChange={() => {}} engine={engine} extraCompletion={source}/>)
  const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!
  act(() => view.dispatch({ selection: { anchor: code.length } }))
  const context = new CompletionContext(view.state, code.length, true)
  const result = source(context)!, option = result.options.find(option => option.label === name)!
  act(() => {
    if (typeof option.apply === 'function') option.apply(view, option, result.from, code.length)
    else view.dispatch({ changes: { from: result.from, to: code.length, insert: option.apply ?? option.label } })
  })
  return { view, selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) }
}
it('selects a function placeholder and traverses it with Tab / Shift+Tab without indenting SQL', () => {
  const { view, selected } = insert('SUBSTR')
  expect(selected()).toBe('string')
  const code = view.state.doc.toString()
  fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab' })
  expect(selected()).toBe('start')
  fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab' })
  expect(selected()).toBe('length')
  fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab', shiftKey: true })
  expect(selected()).toBe('start')
  expect(view.state.doc.toString()).toBe(code)
})
it.each([['CAST', 'expression', 'type', ' AS '], ['EXTRACT', 'field', 'source', ' FROM ']])('keeps %s keyword separators while jumping between fields', (name, first, second, separator) => {
  const { view, selected } = insert(name, 'postgres')
  expect(selected()).toBe(first)
  fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab' })
  expect(selected()).toBe(second)
  expect(view.state.doc.toString()).toContain(first + separator + second)
})
it('does not create placeholder fields for a zero-argument function', () => {
  const { view, selected } = insert('NOW', 'postgres')
  expect(view.state.doc.toString()).toBe('SELECT NOW()')
  expect(selected()).toBe('')
})
