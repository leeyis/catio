import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SqlConsole } from './SqlConsole'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { sql as sqlLanguage } from '@codemirror/lang-sql'
import { dialectFor } from './sqlDialect'
import { invalidateSchemaCache } from '../../services/dbMetadata'
const api = vi.hoisted(() => ({ getSchema: vi.fn(), loadSchemaNamespace: vi.fn(), schemaColumnCatalog: vi.fn(), erRelations: vi.fn(), editor: vi.fn() }))
vi.mock('../../services/db', async original => ({ ...await original<typeof import('../../services/db')>(), ...api }))
vi.mock('./SqlEditor', async () => {
  const { forwardRef } = await import('react')
  return { SqlEditor: forwardRef((_props, _ref) => { api.editor(_props); return <div/> }) }
})
const ns = (name: string) => ({ name, status: 'unloaded', tables: [], views: [], functions: [] })
beforeEach(async () => {
  vi.resetAllMocks(); invalidateSchemaCache()
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
it('shows completion truncation and permission errors rather than claiming complete suggestions', async () => {
  api.schemaColumnCatalog.mockResolvedValue({ tables: [['items',['id']]], errors: [{ schema: 'APP.private', message: 'permission denied' }], truncated: true })
  render(<LanguageProvider><DataProvider><SqlConsole connId="c" engine="postgres" fresh/></DataProvider></LanguageProvider>)
  expect(await screen.findByText(/suggestions are partial/)).toHaveTextContent('APP.private: permission denied')
  expect(screen.getByText(/completion metadata notice/)).toBeInTheDocument()
})
