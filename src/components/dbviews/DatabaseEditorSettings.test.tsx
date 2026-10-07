import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { undoDepth } from '@codemirror/commands'
import { currentCompletions } from '@codemirror/autocomplete'
import { DatabaseEditorSettings } from './DatabaseEditorSettings'
import { SqlEditor } from './SqlEditor'
import { functionCompletions } from './sqlAdvancedCompletion'
import { formatSql } from './sqlFormatter'
import { normalizeDatabaseEditorPreferences, readDatabaseEditorPreferences, updateDatabaseEditorPreferences, DEFAULT_DATABASE_EDITOR_PREFERENCES } from '../../state/databaseEditorPreferences'
import i18n from '../../i18n'

beforeEach(async () => { localStorage.clear(); updateDatabaseEditorPreferences({ ...DEFAULT_DATABASE_EDITOR_PREFERENCES }); await i18n.changeLanguage('en') })
afterEach(() => vi.restoreAllMocks())
it('normalizes untrusted stored preferences without retaining SQL or connection data', () => {
  expect(normalizeDatabaseEditorPreferences({ tabWidth: 999, keywordCase: 'invalid', functionParameters: 'false', sql: 'secret', password: 'secret' })).toEqual(DEFAULT_DATABASE_EDITOR_PREFERENCES)
  updateDatabaseEditorPreferences({ tabWidth: 4, functionParameters: false })
  expect(readDatabaseEditorPreferences()).toMatchObject({ tabWidth: 4, functionParameters: false })
  expect(localStorage.getItem('catio:database:editor-preferences:v1')).not.toContain('secret')
})
it('reconfigures live editors without losing text, selection or undo history', () => {
  const { container } = render(<><SqlEditor code="select 1" onChange={() => {}}/><DatabaseEditorSettings onClose={() => {}}/></>)
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  act(() => view.dispatch({ changes: { from: 8, insert: ' + 2' }, selection: { anchor: 3 } }))
  const before = { text: view.state.doc.toString(), selection: view.state.selection.main.head, undo: undoDepth(view.state) }
  fireEvent.click(screen.getByRole('checkbox', { name: 'Wrap long lines' }))
  fireEvent.change(screen.getByLabelText('Indent width (spaces)'), { target: { value: '4' } })
  expect(view.contentDOM).toHaveClass('cm-lineWrapping')
  expect(view.state.tabSize).toBe(4)
  expect({ text: view.state.doc.toString(), selection: view.state.selection.main.head, undo: undoDepth(view.state) }).toEqual(before)
  fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
  expect(view.contentDOM).not.toHaveClass('cm-lineWrapping')
  expect(view.state.tabSize).toBe(2)
})
it('lets users disable catalog-based table/column hints without storing SQL or metadata',()=>{
  render(<DatabaseEditorSettings onClose={()=>{}}/>)
  const toggle=screen.getByRole('checkbox',{name:'Table and column hints'})
  expect(toggle).toBeChecked();fireEvent.click(toggle)
  expect(readDatabaseEditorPreferences().referenceDiagnostics).toBe(false)
  expect(JSON.parse(localStorage.getItem('catio:database:editor-preferences:v1')!).referenceDiagnostics).toBe(false)
  fireEvent.click(screen.getByRole('button',{name:'Restore defaults'}))
  expect(toggle).toBeChecked()
})
it('reports unavailable storage instead of claiming a successful save', () => {
  readDatabaseEditorPreferences()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  render(<DatabaseEditorSettings onClose={() => {}}/>)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Wrap long lines' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Applied for this session')
  expect(readDatabaseEditorPreferences().lineWrapping).toBe(true)
})
it('manual completion remains available with automatic completion disabled and a different key', async () => {
  updateDatabaseEditorPreferences({ completionOnTyping: false, completionKey: 'Alt-Space' })
  const { container } = render(<SqlEditor code="SELECT * FROM ord" schema={{ orders: ['id'] }} onChange={() => {}}/>)
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  act(() => { view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus() })
  fireEvent.keyDown(view.contentDOM, { key: ' ', code: 'Space', altKey: true })
  await waitFor(() => expect(currentCompletions(view.state).some(c => c.label === 'orders')).toBe(true))
})
it('disables function placeholders without hiding signature documentation', () => {
  const item = functionCompletions('SUBSTRING', 'postgres', false)[0]
  expect(item.apply).toBe('SUBSTRING()')
  expect(item.template).toBe('SUBSTRING(${})')
  expect(item.detail).toBe('SUBSTRING(string, start, length)')
})
it('uses case/indent/comma preferences without changing comma-looking literals or comments', () => {
  const settings = { ...DEFAULT_DATABASE_EDITOR_PREFERENCES, keywordCase: 'lower' as const, tabWidth: 4 as const, commaPosition: 'before' as const }
  const output = formatSql("SELECT a, $$first,\nsecond$$ AS text, b FROM t -- comment,\nWHERE id = 1", 'postgres', settings)
  expect(output).toContain('select\n    a\n    , ')
  expect(output).toContain('$$first,\nsecond$$')
  expect(output).toContain('-- comment,')
  expect(output).toContain('where')
})
