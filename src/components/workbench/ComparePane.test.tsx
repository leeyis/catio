import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { ComparePane } from './ComparePane'
import { DatabaseWorkProvider, hasBusyDatabaseDraftWork, hasPendingDatabaseWork } from '../../state/databaseDraftWork'
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
it('registers sync preview and in-flight work until the real receipt, then clears on unmount', async () => {
  let finish!: (value: number) => void
  const ui = render(<DatabaseWorkProvider owner={{ownerId:'compare-guard',workbenchId:'wb',profileId:'p'}}>{view()}</DatabaseWorkProvider>)
  await readyComparison()
  expect(hasPendingDatabaseWork({ownerId:'compare-guard'})).toBe(true)
  api.execSyncBatch.mockImplementationOnce(() => new Promise(resolve => { finish=resolve }))
  api.queryPage.mockResolvedValue(result([[1,'0xff']], [[0,1]]))
  fireEvent.click(screen.getByRole('button', {name:'Execute'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name:'Execute'}))
  expect(hasBusyDatabaseDraftWork({ownerId:'compare-guard'})).toBe(true)
  await waitFor(()=>expect(api.execSyncBatch).toHaveBeenCalledTimes(1))
  await act(async () => { finish(1) })
  await screen.findByText('Done — 1 row(s) affected')
  expect(hasBusyDatabaseDraftWork({ownerId:'compare-guard'})).toBe(false)
  expect(hasPendingDatabaseWork({ownerId:'compare-guard'})).toBe(false)
  ui.unmount()
  expect(hasPendingDatabaseWork({ownerId:'compare-guard'})).toBe(false)
})
it('shows typed cell differences and executes only the selected rows', async () => {
  api.queryPage.mockResolvedValueOnce(result([[1,'0xff'],[2,'0xaa']], [[0,1],[1,1]])).mockResolvedValueOnce(result([[1,'0x00'],[2,'0xbb']], [[0,1],[1,1]]))
  render(view()); selectTables(); fireEvent.click(screen.getByRole('button', {name:'Compare'}))
  await screen.findByRole('textbox')
  fireEvent.click(screen.getByRole('button', {name:'Inspect Update row 2'}))
  const details = screen.getByRole('region', {name:'Cell differences'})
  expect(details).toHaveTextContent('0xbb'); expect(details).toHaveTextContent('0xaa'); expect(details).toHaveTextContent('HEX')
  fireEvent.click(screen.getByRole('checkbox', {name:'Sync Update row 1'}))
  expect(screen.getByRole('textbox')).toHaveValue('UPDATE [dbo].[dst] SET [payload] = 0xaa WHERE [id] = 2;')
  api.queryPage.mockResolvedValue(result([[1,'0xff'],[2,'0xaa']], [[0,1],[1,1]]))
  fireEvent.click(screen.getByRole('button', {name:'Execute'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name:'Execute'}))
  await screen.findByText('Done — 1 row(s) affected')
  expect(api.execSyncBatch).toHaveBeenCalledWith('c', ['UPDATE [dbo].[dst] SET [payload] = 0xaa WHERE [id] = 2;'])
})
it('does not describe cleared selection as identical or re-enable selection after an unknown write', async () => {
  render(view()); await readyComparison()
  fireEvent.click(screen.getByRole('button', {name:'Clear row selection'}))
  expect(screen.getByRole('textbox')).toHaveValue('-- No eligible changes selected. Differences still exist.')
  expect(screen.getByRole('button', {name:'Execute'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button', {name:'Select all eligible rows'}))
  api.execSyncBatch.mockRejectedValueOnce(new Error('Lost receipt'))
  fireEvent.click(screen.getByRole('button', {name:'Execute'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name:'Execute'}))
  await screen.findByText(/Lost receipt/)
  expect(screen.getByRole('checkbox', {name:'Sync Update row 1'})).toBeDisabled()
  expect(screen.getByRole('button', {name:'Select all eligible rows'})).toBeDisabled()
})
it('synchronously rejects duplicate confirmation events before React rerenders', async () => {
  render(view()); await readyComparison()
  api.execSyncBatch.mockImplementation(() => new Promise(() => {}))
  fireEvent.click(screen.getByRole('button', {name:'Execute'}))
  const run = within(screen.getByRole('dialog')).getByRole('button', {name:'Execute'})
  act(() => { run.click(); run.click() })
  await waitFor(()=>expect(api.execSyncBatch).toHaveBeenCalledTimes(1))
  expect(api.tableStructure).toHaveBeenCalledTimes(4)
})
it('does not publish a successful sync without a valid affected-row receipt', async () => {
  render(view()); await readyComparison()
  api.execSyncBatch.mockResolvedValueOnce(undefined)
  fireEvent.click(screen.getByRole('button', {name:'Execute'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name:'Execute'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('No valid operation receipt')
  expect(screen.getByRole('button', {name:'Execute'})).toBeDisabled()
})

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
it('does not claim rollback or allow replay after an unconfirmed write outcome', async () => {
  render(view()); await readyComparison()
  api.execSyncBatch.mockRejectedValueOnce(new Error('network lost after submission'))
  fireEvent.click(screen.getByRole('button', { name: 'Execute' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Execute' }))
  const message = await screen.findByText(/network lost after submission/)
  expect(message).not.toHaveTextContent(/rolled back/i)
  expect(screen.getByRole('button', { name: 'Execute' })).toBeDisabled()
  expect(api.execSyncBatch).toHaveBeenCalledTimes(1)
})
it('preserves the acknowledged write receipt when refreshing the comparison fails', async () => {
  render(view()); await readyComparison()
  api.queryPage.mockRejectedValueOnce(new Error('readback unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Execute' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Execute' }))
  await screen.findByText('readback unavailable')
  expect(screen.getByText('Done — 1 row(s) affected')).toBeInTheDocument()
  expect(api.execSyncBatch).toHaveBeenCalledTimes(1)
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

it('compares custom non-PK keys read-only without inventing whole-table uniqueness', async () => {
  api.tableStructure.mockResolvedValue({columns:[{name:'id'},{name:'payload'}],indexes:[{name:'possible_partial',cols:'payload',unique:true}],fks:[]})
  render(view());selectTables()
  fireEvent.change(screen.getByLabelText('Matching keys'),{target:{value:'custom'}})
  fireEvent.click(await screen.findByRole('checkbox',{name:'payload'}))
  api.queryPage.mockResolvedValueOnce(result([[1,'same']])).mockResolvedValueOnce(result([[2,'same']]))
  fireEvent.click(screen.getByRole('button',{name:'Compare'}))
  expect(await screen.findByRole('textbox')).toHaveValue('-- Synchronization disabled: matching-key uniqueness is not proven.')
  expect(api.queryPage.mock.calls[0][1]).toContain('ORDER BY [payload]')
  expect(screen.getByRole('button',{name:'Execute'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'Inspect Update row 1'}))
  expect(screen.getByRole('region',{name:'Cell differences'})).toHaveTextContent('1')
  expect(api.execSyncBatch).not.toHaveBeenCalled()
})
it('supports a user-selected composite key that contains both actual primary keys', async () => {
  api.tableStructure.mockImplementation((_conn,_schema,table)=>Promise.resolve({columns:[{name:'id',key:'PK'},{name:'payload',key:table==='dst'?'PK':''},{name:'note'}],indexes:[],fks:[]}))
  render(view());selectTables()
  fireEvent.change(screen.getByLabelText('Matching keys'),{target:{value:'custom'}})
  fireEvent.click(await screen.findByRole('checkbox',{name:'id'}));fireEvent.click(screen.getByRole('checkbox',{name:'payload'}))
  const cols=[...columns,{name:'note',type:'text'}]
  api.queryPage.mockResolvedValueOnce({columns:cols,rows:[[1,'0xff','new']],binaryCells:[[0,1]]}).mockResolvedValueOnce({columns:cols,rows:[[1,'0xff','old']],binaryCells:[[0,1]]})
  fireEvent.click(screen.getByRole('button',{name:'Compare'}))
  expect(await screen.findByRole('textbox')).toHaveValue("UPDATE [dbo].[dst] SET [note] = N'new' WHERE [id] = 1 AND [payload] = 0xff;")
  api.queryPage.mockResolvedValue({columns:cols,rows:[[1,'0xff','new']],binaryCells:[[0,1]]})
  fireEvent.click(screen.getByRole('button',{name:'Execute'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Execute'}))
  await screen.findByText('Done — 1 row(s) affected')
  expect(api.execSyncBatch).toHaveBeenCalledTimes(1)
  expect(api.execSyncBatch.mock.calls[0][1]).toEqual(["UPDATE [dbo].[dst] SET [note] = N'new' WHERE [id] = 1 AND [payload] = 0xff;"])
})
it('clears the diff and open confirmation when custom matching keys change', async () => {
  render(view());await readyComparison()
  fireEvent.click(screen.getByRole('button',{name:'Execute'}))
  fireEvent.change(screen.getByLabelText('Matching keys'),{target:{value:'custom'}})
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button',{name:'Compare'})).toBeDisabled()
  await screen.findByRole('checkbox',{name:'id'})
})
it('rechecks structure before dispatch and rejects a changed primary key without writing', async () => {
  render(view());await readyComparison()
  api.tableStructure.mockResolvedValue({columns:[{name:'id'},{name:'payload'}]})
  fireEvent.click(screen.getByRole('button',{name:'Execute'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Execute'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('No write was sent')
  expect(api.execSyncBatch).not.toHaveBeenCalled()
  expect(screen.getByRole('button',{name:'Execute'})).toBeDisabled()
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
