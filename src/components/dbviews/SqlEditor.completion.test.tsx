import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { CompletionContext, type CompletionSource, currentCompletions, startCompletion, acceptCompletion } from '@codemirror/autocomplete'
import { undoDepth } from '@codemirror/commands'
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, PLSQL } from '@codemirror/lang-sql'
import { SqlEditor, dialectFor, type SqlEditorProps } from './SqlEditor'
import { completionSchema } from './sqlCompletionSchema'
import { sqlAdvancedCompletion } from './sqlAdvancedCompletion'
import '../../i18n'

const schema = { audit: { orders: ['audit_only'] }, app: { orders: ['app_only', 'note'] } }
function mount(text: string, props: Partial<SqlEditorProps> = {}) {
  const pos = text.indexOf('|') >= 0 ? text.indexOf('|') : text.length
  const code = text.replace('|', '')
  const rendered = render(<SqlEditor code={code} onChange={() => {}} schema={schema} {...props}/>)
  const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!
  act(() => view.dispatch({ selection: { anchor: pos } }))
  return { ...rendered, view, code }
}
async function candidates(view: EditorView) {
  const pos = view.state.selection.main.head
  // These cases assert scope semantics, not the scheduler's 10 ms parsing slice.
  // Lagging published trees and exhausted budgets have separate controlled tests.
  expect(ensureSyntaxTree(view.state,view.state.doc.length,100)).not.toBeNull()
  const context = new CompletionContext(view.state, pos, true)
  const results = await Promise.all(view.state.languageDataAt<CompletionSource>('autocomplete', pos).map(source => source(context)))
  return results.flatMap(result => result?.options ?? [])
}

describe('live SQL dialect and namespace completion', () => {
  it.each([
    ['mysql', MySQL], ['tidb', MySQL], ['sqlite', SQLite], ['rqlite', SQLite],
    ['duckdb', PostgreSQL], ['sqlserver', MSSQL], ['oracle', PLSQL], ['jdbc', StandardSQL],
  ])('selects an explicit parser for %s', (engine, dialect) => expect(dialectFor(engine).spec).toMatchObject(dialect.spec))

  it('actually mounts the MySQL parser for backtick identifiers', () => {
    const { view } = mount('SELECT `order details`', { engine: 'mysql' })
    // Reconfiguration schedules parsing; this assertion tests dialect identity,
    // not whether the background parser happened to win a loaded CI timeslice.
    expect(ensureSyntaxTree(view.state,view.state.doc.length,100)?.toString()).toContain('QuotedIdentifier')
  })
  it('resolves an alias against the actual default schema instead of the first catalog entry', async () => {
    const { view } = mount('SELECT o.| FROM orders o', { defaultSchema: 'app', engine: 'postgres' })
    const names = (await candidates(view)).map(c => c.label)
    expect(names).toContain('app_only'); expect(names).not.toContain('audit_only')
  })
  it('preserves explicit schema qualification', async () => {
    const { view } = mount('SELECT o.| FROM audit.orders o', { defaultSchema: 'app', engine: 'postgres' })
    const names = (await candidates(view)).map(c => c.label)
    expect(names).toContain('audit_only'); expect(names).not.toContain('app_only')
  })
  it.each(["SELECT 'ord|", 'SELECT 1 -- ord|', 'SELECT /* ord|', 'SELECT $tag$ord|'])('suppresses even explicit SQL suggestions inside literals and comments: %s', async text => {
    const { view } = mount(text, { engine: 'postgres', defaultSchema: 'app', extraCompletion: c => ({ from: c.pos, options: [{ label: 'SHOULD_NOT_APPEAR' }] }) })
    expect(await candidates(view)).toEqual([])
  })
  it.each(['mysql', 'mariadb'])('keeps backslash-escaped quotes inside a default %s string', async engine => {
    const { view } = mount("SELECT 'it\\'s ord|", { engine, defaultSchema: 'app' })
    expect(await candidates(view)).toEqual([])
  })
  it('reconfigures schema and dialect without replacing the document, selection or undo history', async () => {
    const { view, rerender, code } = mount('SELECT o.| FROM orders o', { defaultSchema: 'app', engine: 'postgres' })
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: ' ' } }))
    const before = { doc: view.state.doc.toString(), cursor: view.state.selection.main.head, undo: undoDepth(view.state) }
    rerender(<SqlEditor code={code} onChange={() => {}} schema={schema} defaultSchema="audit" engine="sqlserver"/>)
    expect({ doc: view.state.doc.toString(), cursor: view.state.selection.main.head, undo: undoDepth(view.state) }).toEqual(before)
    expect((await candidates(view)).map(c => c.label)).toContain('audit_only')
  })
  it('offers and accepts a qualified JOIN target through the actual editor guard and filter', async () => {
    const extraCompletion = sqlAdvancedCompletion(() => 'postgres', () => [
      { schema: 'app', name: 'orders', columns: ['owner'], foreignKeys: [{ column: 'owner', refSchema: 'auth', refTable: 'users', refColumn: 'id', constraintId: 'fk', ordinal: 1, columnCount: 1 }] },
      { schema: 'auth', name: 'users', columns: ['id'], foreignKeys: [] },
    ], () => 'app')
    const { view } = mount('SELECT * FROM orders o LEFT JOIN auth.us|', { schema: {}, engine: 'postgres', defaultSchema: 'app', extraCompletion })
    act(() => { startCompletion(view) })
    await waitFor(() => expect(currentCompletions(view.state)[0]?.detail).toBe('FK JOIN'))
    await new Promise(resolve => setTimeout(resolve, 100)) // CodeMirror's normal acceptance guard.
    act(() => { expect(acceptCompletion(view)).toBe(true) })
    expect(view.state.doc.toString()).toBe('SELECT * FROM orders o LEFT JOIN "auth"."users" ON o."owner" = "auth"."users"."id"')
  })
  it('accepts a visible completion with Tab rather than inserting indentation', async () => {
    const { view } = mount('SELECT * FROM app.ord|', { defaultSchema: 'app' })
    act(() => { view.focus(); startCompletion(view) })
    await waitFor(() => expect(currentCompletions(view.state).map(c => c.label)).toContain('orders'))
    // Wait beyond CodeMirror's default acceptance guard (75 ms), without changing production timing.
    await new Promise(resolve => setTimeout(resolve, 100))
    fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab' })
    expect(view.state.doc.toString()).toBe('SELECT * FROM app.orders')
  })
  it.each([
    ['WITH recent AS (SELECT app_only AS public_id FROM app.orders) SELECT r.| FROM recent r', ['public_id']],
    ['WITH recent (key, amount) AS (SELECT app_only, note FROM app.orders) SELECT r.| FROM recent r', ['key', 'amount']],
    ['SELECT q.| FROM (SELECT app_only AS public_id FROM app.orders) q', ['public_id']],
    ['WITH r AS (SELECT o.* FROM app.orders o) SELECT r.| FROM r', ['app_only', 'note']],
    ['WITH RECURSIVE r (n) AS (SELECT 1 UNION ALL SELECT r.n + 1 FROM r) SELECT r.| FROM r', ['n']],
    ['WITH a AS (SELECT app_only AS public_id FROM app.orders), b AS (SELECT * FROM a) SELECT b.| FROM b', ['public_id']],
  ])('resolves projected CTE/derived-table columns: %s', async (text, expected) => {
    const { view } = mount(text, { defaultSchema: 'app' })
    const names = (await candidates(view)).map(c => c.label)
    expect(names).toEqual(expected)
  })
  it('uses the nearest query alias instead of leaking an outer alias with the same name', async () => {
    const { view } = mount('SELECT (SELECT o.| FROM audit.orders o) FROM app.orders o', { defaultSchema: 'app' })
    const names = (await candidates(view)).map(c => c.label)
    expect(names).toContain('audit_only'); expect(names).not.toContain('app_only')
  })
  it('does not expose a later CTE inside an earlier definition', async () => {
    const { view } = mount('WITH first_cte AS (SELECT * FROM |), later_cte AS (SELECT * FROM app.orders) SELECT * FROM first_cte', { defaultSchema: 'app' })
    const names = (await candidates(view)).map(c => c.label)
    expect(names).not.toContain('later_cte'); expect(names).not.toContain('first_cte')
  })
  it.each([
    ['postgres', 'publicid', '"publicid"'], ['h2', 'PUBLICID', '"PUBLICID"'],
    ['sqlite', 'PublicID', 'PublicID'], ['jdbc', 'PublicID', 'PublicID'],
  ])('does not quote an unquoted projection into a different column on %s', async (engine, label, apply) => {
    const { view } = mount('WITH r AS (SELECT 1 AS PublicID) SELECT r.| FROM r', { engine, defaultSchema: 'app' })
    expect(await candidates(view)).toContainEqual(expect.objectContaining({ label, apply }))
  })
  it('applies PostgreSQL case folding to a bare CTE completion', async () => {
    const { view } = mount('WITH Recent AS (SELECT 1 AS id) SELECT * FROM rec|', { engine: 'postgres' })
    expect(await candidates(view)).toContainEqual(expect.objectContaining({ label: 'recent', apply: '"recent"' }))
  })
  it('keeps CTEs statement-local', async () => {
    const { view } = mount('WITH previous_cte AS (SELECT * FROM audit.orders) SELECT * FROM previous_cte; SELECT * FROM |', { defaultSchema: 'app' })
    expect((await candidates(view)).map(c => c.label)).not.toContain('previous_cte')
  })
  it('does not invent a derived-table column name for an unaliased expression', async () => {
    const { view } = mount('SELECT q.| FROM (SELECT note || app_only FROM app.orders) q', { defaultSchema: 'app' })
    expect(await candidates(view)).toEqual([])
  })
  it('suggests local CTEs as table candidates', async () => {
    const { view } = mount('WITH recent AS (SELECT app_only FROM app.orders) SELECT * FROM rec|', { defaultSchema: 'app' })
    expect((await candidates(view)).map(c => c.label)).toContain('recent')
  })
  it('retains literal dots, escaped quotes and prototype-like object names in real metadata', async () => {
    const metadata = completionSchema([{ name: 'app.v1', tables: [{ name: '__proto__' }], views: [] }], () => ['odd.column', 'a"b'], 'postgres')
    const { view } = mount('SELECT p.| FROM "app.v1"."__proto__" p', { defaultSchema: 'app.v1', schema: metadata })
    const options = await candidates(view)
    expect(options.find(c => c.label === 'odd.column')?.apply).toBe('"odd.column"')
    expect(options.find(c => c.label === 'a"b')?.apply).toBe('"a""b"')
  })
  it('does not run SQL on an IME confirmation key', () => {
    const onRun = vi.fn()
    const { view } = mount('SELECT 1', { onRun })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter', code: 'Enter', altKey: true, isComposing: true, keyCode: 229 })
    expect(onRun).not.toHaveBeenCalled()
  })
})
