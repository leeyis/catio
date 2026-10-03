import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { ComparePane } from './ComparePane'
import type { QueryResult, SchemaNamespace } from '../../services/types'

const api = vi.hoisted(() => ({ queryPage: vi.fn(), tableStructure: vi.fn(), getSchema: vi.fn(), execSyncBatch: vi.fn() }))
vi.mock('../../services/db', async original => ({ ...await original<typeof import('../../services/db')>(), ...api }))
vi.mock('../../state/dbConnections', () => ({ listActiveDbConnections: () => [
  { connId: 'c', name: 'Source', dbType: 'sqlserver' }, { connId: 'other', name: 'Target', dbType: 'sqlserver' },
] }))
const schemas: SchemaNamespace[] = [{ name: 'dbo', tables: ['src','dst'].map(name => ({ name, rows: '', cols: 2 })), views: [], functions: [] }]
const columns = [{ name: 'id', type: 'int' }, { name: 'payload', type: 'varbinary' }]
const result = (rows: unknown[][], binaryCells: [number,number][] = []): QueryResult => ({ columns, rows, binaryCells })
const view = (connId = 'c') => <LanguageProvider><ComparePane connId={connId} engine="sqlserver" schemas={schemas}/></LanguageProvider>
function selectTables() {
  const fields = screen.getAllByRole('combobox')
  fireEvent.change(fields[1], { target: { value: 'src' } })
  fireEvent.change(fields[4], { target: { value: 'dst' } })
}
beforeEach(async () => {
  vi.clearAllMocks()
  api.tableStructure.mockResolvedValue({ columns: [{ name: 'id', key: 'PK' }, { name: 'payload' }] })
  api.getSchema.mockResolvedValue({ db: 'c', schemas, defaultNamespace: 'dbo' })
  api.execSyncBatch.mockResolvedValue(1)
  await i18n.changeLanguage('en')
})
afterEach(() => vi.restoreAllMocks())

async function readyComparison() {
  api.queryPage.mockResolvedValueOnce(result([[1,'0xff']], [[0,1]])).mockResolvedValueOnce(result([[1,'0x00']], [[0,1]]))
  selectTables(); fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
  await screen.findByRole('textbox')
}
it('confirms the target in-app and never writes on cancel', async () => {
  const native = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(view()); await readyComparison()
  fireEvent.click(screen.getByRole('button', { name: 'Execute' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/Source.*dbo\.dst/)).toBeInTheDocument()
  expect(native).not.toHaveBeenCalled(); expect(api.execSyncBatch).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(api.execSyncBatch).not.toHaveBeenCalled()
})
it('executes only the confirmed typed batch and refreshes the comparison', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(view()); await readyComparison()
  api.queryPage.mockResolvedValue(result([[1,'0xff']], [[0,1]]))
  fireEvent.click(screen.getByRole('button', { name: 'Execute' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Execute' }))
  await screen.findByText('Done — 1 row(s) affected')
  expect(api.execSyncBatch).toHaveBeenCalledTimes(1)
  expect(api.execSyncBatch).toHaveBeenCalledWith('c', ['UPDATE [dbo].[dst] SET [payload] = 0xff WHERE [id] = 1;'])
  expect(screen.getByRole('textbox')).toHaveValue('-- Tables are identical, nothing to sync')
})
it('invalidates an open execution confirmation when its connection changes', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  const rendered = render(view()); await readyComparison()
  fireEvent.click(screen.getByRole('button', { name: 'Execute' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  rendered.rerender(view('replacement'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(api.execSyncBatch).not.toHaveBeenCalled()
})

it('uses dialect-aware paging and preserves typed cells in the generated sync SQL', async () => {
  api.queryPage.mockResolvedValueOnce(result([[1,'0xff']], [[0,1]])).mockResolvedValueOnce(result([[1,'0x00']], [[0,1]]))
  render(view()); selectTables(); fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
  await waitFor(() => expect(api.queryPage).toHaveBeenCalledTimes(2))
  expect(api.queryPage.mock.calls[0]).toEqual(['c', 'SELECT * FROM [dbo].[src] ORDER BY [id]', 5000, 0])
  expect(await screen.findByRole('textbox')).toHaveValue('UPDATE [dbo].[dst] SET [payload] = 0xff WHERE [id] = 1;')
})
it('rejects a target without the same unique primary key before querying rows', async () => {
  api.tableStructure.mockResolvedValueOnce({ columns: [{ name: 'id', key: 'PK' }] }).mockResolvedValueOnce({ columns: [{ name: 'id' }] })
  render(view()); selectTables(); fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
  await screen.findByText(/matching primary keys/i)
  expect(api.queryPage).not.toHaveBeenCalled(); expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})
it('preserves a table selection made while the rest of the catalog is loading', async () => {
  let resolve!: (value: unknown) => void
  api.getSchema.mockImplementationOnce(() => new Promise(ok => { resolve = ok }))
  const pending: SchemaNamespace[] = [
    { ...schemas[0], name: 'HIDDEN', status: 'loaded' },
    { name: 'PUBLIC', status: 'unloaded', tables: [], views: [], functions: [] },
  ]
  render(<LanguageProvider><ComparePane connId="c" engine="sqlserver" schemas={pending}/></LanguageProvider>)
  selectTables()
  await act(async () => { resolve({ db: 'c', defaultNamespace: 'PUBLIC', schemas: pending.map(ns => ({ ...ns, status: 'loaded' })) }) })
  const fields = screen.getAllByRole('combobox')
  expect(fields[0]).toHaveValue('HIDDEN'); expect(fields[3]).toHaveValue('HIDDEN')
  expect(fields[1]).toHaveValue('src'); expect(fields[4]).toHaveValue('dst')
})

it('does not publish a comparison result after the source connection changes', async () => {
  let resolve!: (value: QueryResult) => void
  api.queryPage.mockImplementationOnce(() => new Promise(ok => { resolve = ok })).mockResolvedValue(result([]))
  const rendered = render(view()); selectTables(); fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
  await waitFor(() => expect(api.queryPage).toHaveBeenCalledTimes(1))
  rendered.rerender(view('replacement'))
  await act(async () => { resolve(result([[1,'0xff']], [[0,1]])) })
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})
