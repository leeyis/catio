import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { sqlFunctionSignatureHelp } from './sqlAdvancedCompletion'
import { SqlEditor } from './SqlEditor'
import '../../i18n'

it.each([
  ['postgres', "SELECT SUBSTRING($q$x,(,y$q$, 2", 'SUBSTRING', 1],
  ['postgres', 'SELECT SUBSTRING(name /* ), (, , */, 2', 'SUBSTRING', 1],
  ['postgres', 'SELECT COALESCE(ARRAY[1,2], NULL', 'COALESCE', 1],
  ['postgres', 'SELECT ROUND((amount + 1)', 'ROUND', 0],
  ['mysql', "SELECT SUBSTRING('it\\'s , (', 2", 'SUBSTRING', 1],
  ['oracle', "SELECT SUBSTR(q'[a,b(]', 2", 'SUBSTR', 1],
  ['sqlserver', 'SELECT SUBSTRING([col,umn], 2', 'SUBSTRING', 1],
  ['postgres', 'SELECT CAST(amount AS numeric', 'CAST', 1],
  ['sqlserver', 'SELECT TRY_CAST(amount AS int', 'TRY_CAST', 1],
  ['postgres', 'SELECT EXTRACT(YEAR FROM created_at', 'EXTRACT', 1],
])('tracks %s lexical context and the active argument: %s', (engine, code, name, activeParameter) => {
  expect(sqlFunctionSignatureHelp(code, code.length, engine)).toMatchObject({ name, activeParameter })
})
it.each([
  'SELECT 1 -- SUBSTRING(', "SELECT 'SUBSTRING('", 'SELECT /* SUBSTRING(',
  'SELECT SUBSTRING(name, -- comment', 'SELECT SUBSTRING(; SELECT x',
  'SELECT app.SUBSTRING(', 'SELECT SUBSTRING((SELECT x FROM t',
])('does not invent function context in %s', code => {
  expect(sqlFunctionSignatureHelp(code, code.length, 'postgres')).toBeNull()
})
it('does not scan an unbounded single statement', () => {
  const code = 'SELECT SUBSTRING(' + ' '.repeat(200_001)
  expect(sqlFunctionSignatureHelp(code, code.length, 'postgres')).toBeNull()
})
function mount(code: string, engine = 'postgres', plain = false) {
  const rendered = render(<SqlEditor code={code} engine={engine} plain={plain} onChange={() => {}}/>)
  const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!
  act(() => { view.dispatch({ selection: { anchor: code.length } }); view.focus() })
  return { ...rendered, view }
}
it('renders the live active parameter, follows nested calls, and disappears outside the call', async () => {
  const { view } = mount('SELECT SUBSTRING(name, ')
  let tip = await screen.findByRole('tooltip', { name: '函数参数' })
  expect(tip.querySelector('[data-active-parameter="true"]')).toHaveTextContent('start')
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: 'ABS(' }, selection: { anchor: view.state.doc.length + 4 } }))
  await waitFor(() => expect(screen.getByRole('tooltip', { name: '函数参数' })).toHaveTextContent('ABS(number)'))
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '2), 3' }, selection: { anchor: view.state.doc.length + 5 } }))
  tip = await screen.findByRole('tooltip', { name: '函数参数' })
  await waitFor(() => expect(tip.querySelector('[data-active-parameter="true"]')).toHaveTextContent('length'))
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: ')' }, selection: { anchor: view.state.doc.length + 1 } }))
  await waitFor(() => expect(screen.queryByRole('tooltip', { name: '函数参数' })).toBeNull())
})
it('Escape dismisses the hint, explicit shortcut restores it, and blur hides it without editing SQL', async () => {
  const { view } = mount('SELECT ROUND(1, ')
  await screen.findByRole('tooltip', { name: '函数参数' })
  fireEvent.keyDown(view.contentDOM, { key: 'Escape', code: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('tooltip', { name: '函数参数' })).toBeNull())
  fireEvent.keyDown(view.contentDOM, { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true })
  await screen.findByRole('tooltip', { name: '函数参数' })
  expect(view.state.doc.toString()).toBe('SELECT ROUND(1, ')
  act(() => view.contentDOM.blur())
  await waitFor(() => expect(screen.queryByRole('tooltip', { name: '函数参数' })).toBeNull())
})
it('reconfigures the signature dialect without resetting text and never mounts SQL hints in plain mode', async () => {
  const { view, rerender } = mount('SELECT DATEDIFF(a, ', 'sqlserver')
  expect(await screen.findByRole('tooltip', { name: '函数参数' })).toHaveTextContent('DATEDIFF(datepart, startdate, enddate)')
  const code = view.state.doc.toString()
  rerender(<SqlEditor code={code} engine="mysql" onChange={() => {}}/>)
  act(() => { view.contentDOM.blur(); view.focus() })
  await waitFor(() => expect(screen.getByRole('tooltip', { name: '函数参数' })).toHaveTextContent('DATEDIFF(date1, date2)'))
  rerender(<SqlEditor code={code} plain engine="mongodb" onChange={() => {}}/>)
  await waitFor(() => expect(screen.queryByRole('tooltip', { name: '函数参数' })).toBeNull())
  expect(view.state.doc.toString()).toBe(code)
})
