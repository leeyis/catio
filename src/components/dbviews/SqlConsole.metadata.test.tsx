import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SqlConsole } from './SqlConsole'
import { EditorState } from '@codemirror/state'
import type {EditorView} from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { sql as sqlLanguage } from '@codemirror/lang-sql'
import { dialectFor } from './sqlDialect'
import { invalidateSchemaCache } from '../../services/dbMetadata'
import {updateDatabaseEditorPreferences,DEFAULT_DATABASE_EDITOR_PREFERENCES} from '../../state/databaseEditorPreferences'
const api = vi.hoisted(() => ({ getSchema: vi.fn(), loadSchemaNamespace: vi.fn(), schemaColumnCatalog: vi.fn(), erRelations: vi.fn(), editor: vi.fn() }))
vi.mock('../../services/db', async original => ({ ...await original<typeof import('../../services/db')>(), ...api }))
vi.mock('./SqlEditor', async () => {
  const { forwardRef } = await import('react')
  return { SqlEditor: forwardRef((_props, _ref) => { api.editor(_props); return <div/> }) }
})
const ns = (name: string) => ({ name, status: 'unloaded', tables: [], views: [], functions: [] })
beforeEach(async () => {
  localStorage.clear();updateDatabaseEditorPreferences({...DEFAULT_DATABASE_EDITOR_PREFERENCES});vi.resetAllMocks(); invalidateSchemaCache()
  api.getSchema.mockResolvedValue({ db: 'c', defaultNamespace: 'APP', schemas: ['INFORMATION_SCHEMA','APP','OTHER','UNUSED'].map(ns) })
  api.loadSchemaNamespace.mockImplementation((_id, name) => Promise.resolve({ ...ns(name), status: 'loaded' }))
  api.schemaColumnCatalog.mockResolvedValue({ tables: [], errors: [], truncated: false })
  api.erRelations.mockResolvedValue([])
  await i18n.changeLanguage('en')
})
it('loads completion only for the current and explicitly referenced namespaces', async () => {
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" connName="Reporting replica" engine="postgres" fresh initialCode="SELECT * FROM OTHER.items"/></DataProvider></LanguageProvider>)
  await waitFor(() => expect(api.schemaColumnCatalog).toHaveBeenCalledWith('c','APP'))
  expect(api.schemaColumnCatalog).toHaveBeenCalledWith('c','OTHER')
  for (const method of [api.loadSchemaNamespace, api.schemaColumnCatalog, api.erRelations]) {
    expect(method.mock.calls.every(([, name]) => ['APP','OTHER'].includes(name))).toBe(true)
  }
  expect(screen.getByTestId('sql-default-schema')).toHaveValue('APP')
  expect(api.editor.mock.calls.at(-1)?.[0]).toMatchObject({ engine: 'postgres', defaultSchema: 'APP', target: 'Reporting replica' })
})
it('loads the actual namespace even when the engine has no session-schema selector', async () => {
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="sqlserver" fresh/></DataProvider></LanguageProvider>)
  await waitFor(() => expect(api.schemaColumnCatalog).toHaveBeenCalledWith('c','APP'))
  expect(api.editor.mock.calls.at(-1)?.[0]).toMatchObject({ engine: 'sqlserver', defaultSchema: 'APP' })
})
it('does not request metadata for a schema mentioned only in a comment or literal', async () => {
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh initialCode="SELECT 'OTHER.secret' /* UNUSED.table */"/></DataProvider></LanguageProvider>)
  await waitFor(() => expect(api.schemaColumnCatalog).toHaveBeenCalledWith('c','APP'))
  for (const method of [api.loadSchemaNamespace, api.schemaColumnCatalog, api.erRelations]) {
    expect(method.mock.calls.every(([, name]) => name === 'APP')).toBe(true)
  }
})
it('uses the JDBC profile rather than the transport name for function completion', async () => {
  const sql = 'SELECT NV'
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="jdbc" engineId="oracle" fresh initialCode={sql}/></DataProvider></LanguageProvider>)
  await waitFor(() => expect(api.schemaColumnCatalog).toHaveBeenCalledWith('c','APP'))
  const props = api.editor.mock.calls.at(-1)?.[0]
  const result = props.extraCompletion(new CompletionContext(EditorState.create({ doc: sql, extensions: [sqlLanguage({ dialect: dialectFor('oracle') })] }), sql.length, true))
  expect(result.options).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'NVL' })]))
})
it('wires full foreign-key identities and the actual default schema into JOIN completion', async () => {
  api.erRelations.mockImplementation((_id, schema) => Promise.resolve(schema === 'APP' ? [
    { from: 'orders', fromCol: 'owner_id', to: 'users', toCol: 'id', fromSchema: 'APP', toSchema: 'OTHER', constraintId: 'fk_owner', ordinal: 1, columnCount: 1 },
  ] : []))
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh/></DataProvider></LanguageProvider>)
  const code = 'SELECT * FROM orders o JOIN '
  await waitFor(() => {
    const props = api.editor.mock.calls.at(-1)?.[0]
    const state = EditorState.create({ doc: code, extensions: [sqlLanguage({ dialect: dialectFor('postgres') })] })
    const result = props.extraCompletion(new CompletionContext(state, code.length, true))
    expect(result?.options).toEqual(expect.arrayContaining([expect.objectContaining({ apply: '"OTHER"."users" ON o."owner_id" = "OTHER"."users"."id"' })]))
  })
})
it('re-lints loaded namespace identity, locale and connection changes without borrowing an old catalog',async()=>{
  let complete!: (value:unknown)=>void
  api.loadSchemaNamespace.mockImplementation((_id,name)=>name==='APP'?new Promise(resolve=>{complete=resolve}):Promise.resolve({...ns(name),status:'loaded'}))
  const text='SELECT * FROM "APP".missing;'
  const state=EditorState.create({doc:text,extensions:[dialectFor('postgres').language]})
  const read=()=>api.editor.mock.calls.at(-1)![0].lintSource({state} as EditorView)
  const {rerender}=render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  await waitFor(()=>expect(complete).toBeDefined())
  expect(read()).toEqual([])
  const before=api.editor.mock.calls.at(-1)![0].lintSource
  await act(async()=>complete({...ns('APP'),status:'loaded',tables:[{name:'present',cols:1,rows:'0'}]}))
  await waitFor(()=>expect(read()[0]?.message).toContain('not found in the loaded catalog'))
  expect(api.editor.mock.calls.at(-1)![0].lintSource).not.toBe(before)
  await act(async()=>{await i18n.changeLanguage('zh')})
  await waitFor(()=>expect(read()[0]?.message).toContain('已加载目录'))
  api.getSchema.mockReturnValue(new Promise(()=>{}))
  rerender(<LanguageProvider><DataProvider><SqlConsole connId="other" engine="postgres" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  expect(read()).toEqual([])
})
it('adds column diagnostics only after complete catalogs arrive and never borrows them across connections',async()=>{
  let complete!:(value:unknown)=>void
  api.schemaColumnCatalog.mockReturnValue(new Promise(resolve=>{complete=resolve}))
  api.loadSchemaNamespace.mockImplementation((_id,name)=>Promise.resolve({...ns(name),status:'loaded',tables:[{name:'orders',cols:1,rows:'0'}]}))
  const text='SELECT o.missing FROM orders o;',state=EditorState.create({doc:text,extensions:[dialectFor('postgres').language]})
  const read=()=>api.editor.mock.calls.at(-1)![0].lintSource({state} as EditorView)
  const {rerender}=render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  await waitFor(()=>expect(api.schemaColumnCatalog).toHaveBeenCalled())
  expect(read()).toEqual([])
  await act(async()=>complete({tables:[['orders',['id']]],errors:[],truncated:false}))
  await waitFor(()=>expect(read()[0]?.message).toContain('Column missing'))
  act(()=>updateDatabaseEditorPreferences({referenceDiagnostics:false}))
  expect(read()).toEqual([])
  act(()=>updateDatabaseEditorPreferences({referenceDiagnostics:true}))
  await waitFor(()=>expect(read()[0]?.message).toContain('Column missing'))
  api.getSchema.mockReturnValue(new Promise(()=>{}))
  rerender(<LanguageProvider><DataProvider><SqlConsole connId="other" engine="postgres" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  expect(read()).toEqual([])
})
it.each([{errors:[{schema:'APP',message:'partial'}],truncated:false},{errors:[],truncated:true}])('does not use a partial column response as proof of absence: %j',async flags=>{
  api.loadSchemaNamespace.mockImplementation((_id,name)=>Promise.resolve({...ns(name),status:'loaded',tables:[{name:'orders',cols:1,rows:'0'}]}))
  api.schemaColumnCatalog.mockResolvedValue({tables:[['orders',['id']]],...flags})
  const text='SELECT o.missing FROM orders o;',state=EditorState.create({doc:text,extensions:[dialectFor('postgres').language]})
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  await screen.findByText(/completion metadata notice/)
  expect(api.editor.mock.calls.at(-1)![0].lintSource({state} as EditorView)).toEqual([])
})
it('invalidates column evidence immediately and ignores a pre-invalidation late response',async()=>{
  const requests:((value:unknown)=>void)[]=[]
  api.schemaColumnCatalog.mockImplementation(()=>new Promise(resolve=>requests.push(resolve)))
  api.loadSchemaNamespace.mockImplementation((_id,name)=>Promise.resolve({...ns(name),status:'loaded',tables:[{name:'orders',cols:1,rows:'0'}]}))
  const text='SELECT o.missing FROM orders o;',state=EditorState.create({doc:text,extensions:[dialectFor('postgres').language]})
  const read=()=>api.editor.mock.calls.at(-1)![0].lintSource({state} as EditorView)
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  await waitFor(()=>expect(requests).toHaveLength(1))
  act(()=>invalidateSchemaCache('c',{schema:'APP'}))
  await act(async()=>requests[0]({tables:[['orders',['id']]],errors:[],truncated:false}))
  expect(read()).toEqual([])
  await waitFor(()=>expect(requests).toHaveLength(2))
  await act(async()=>requests[1]({tables:[['orders',['id']]],errors:[],truncated:false}))
  await waitFor(()=>expect(read()[0]?.message).toContain('Column missing'))
  act(()=>invalidateSchemaCache('c',{schema:'APP'}))
  expect(read()).toEqual([])
})
it('uses the JDBC engine profile for diagnostics as well as completion',async()=>{
  const text="SELECT q'[)]' FROM unqualified_table"
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="jdbc" engineId="oracle" fresh initialCode={text}/></DataProvider></LanguageProvider>)
  await waitFor(()=>expect(api.editor).toHaveBeenCalled())
  const state=EditorState.create({doc:text,extensions:[dialectFor('oracle').language]})
  expect(api.editor.mock.calls.at(-1)![0].lintSource({state} as EditorView).filter((d:{severity:string})=>d.severity==='error')).toEqual([])
})
it('shows completion truncation and permission errors rather than claiming complete suggestions', async () => {
  api.schemaColumnCatalog.mockResolvedValue({ tables: [['items',['id']]], errors: [{ schema: 'APP.private', message: 'permission denied' }], truncated: true })
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh/></DataProvider></LanguageProvider>)
  expect(await screen.findByText(/suggestions are partial/)).toHaveTextContent('APP.private: permission denied')
  expect(screen.getByText(/completion metadata notice/)).toBeInTheDocument()
})
