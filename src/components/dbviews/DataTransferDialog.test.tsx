import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { DataTransferDialog } from './DataTransferDialog'
import { DatabaseWorkProvider, hasBusyDatabaseDraftWork } from '../../state/databaseDraftWork'

const transferTable = vi.fn(), tableStructure = vi.fn(), getSchema = vi.fn()
vi.mock('../../services/db', () => ({
  transferTable: (...a: unknown[]) => transferTable(...a), tableStructure: (...a: unknown[]) => tableStructure(...a),
  getSchema: (...a: unknown[]) => getSchema(...a), dbErrMsg: (e: unknown) => e instanceof Error ? e.message : String(e),
}))
const columns = [
  { name: 'user_id', type: 'int', nullable: false, default: null, key: 'PK', extra: '', comment: '' },
  { name: 'display_name', type: 'text', nullable: true, default: null, key: '', extra: '', comment: '' },
]
const structure = { columns, indexes: [], fks: [], comment: '' }
const connections = [{ id: 'src', name: 'prod-pg', engine: 'postgres' }, { id: 'dst', name: 'analytics-ch', engine: 'clickhouse' }]
const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)
function mount(extra: Partial<React.ComponentProps<typeof DataTransferDialog>> = {}) {
  return wrap(<DataTransferDialog connections={connections} initialSourceConnId="src" initialSourceSchema="public" initialSourceTable="users" onClose={() => {}} {...extra}/>)
}
async function target(value = 'users_copy') {
  fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'dst' } })
  await waitFor(() => expect(within(screen.getByLabelText('transfer-target-table')).getByRole('option', { name: value })).toBeInTheDocument())
  await act(async () => { fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value } }) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled())
}
function next() { fireEvent.click(screen.getByRole('button', { name: 'Next' })) }
async function review() { await target(); next(); next() }
async function run() {
  const button = screen.getByRole('button', { name: /Migrate 2 column/i })
  await act(async () => { fireEvent.click(button); fireEvent.click(button) })
}
const noReplay = () => expect(screen.queryByRole('button', { name: /Migrate .*column/i })).not.toBeInTheDocument()

describe('data-only migration wizard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    transferTable.mockReset(); tableStructure.mockReset(); getSchema.mockReset()
    tableStructure.mockResolvedValue(structure)
    getSchema.mockResolvedValue({ schemas: [{ name: 'analytics', tables: [{ name: 'users_copy' }, { name: 'users' }] }] })
    transferTable.mockResolvedValue({ rowsTransferred: 42 })
  })
  it('reviews source, target, mappings and data-only boundary before dispatching append', async () => {
    mount(); await target()
    expect(screen.getByLabelText('transfer-target-schema')).toHaveValue('analytics')
    expect(screen.getByLabelText('transfer-target-table').tagName).toBe('SELECT')
    expect(transferTable).not.toHaveBeenCalled()
    next(); expect(screen.getByLabelText('map-user_id')).toHaveValue('user_id')
    next(); expect(screen.getByTestId('dbtransfer-review')).toHaveTextContent('analytics-ch · analytics.users_copy')
    expect(screen.getByTestId('dbtransfer-review')).toHaveTextContent('prod-pg · public.users')
    expect(transferTable).not.toHaveBeenCalled()
    await run()
    expect(transferTable).toHaveBeenCalledTimes(1)
    expect(transferTable).toHaveBeenCalledWith({ sourceConnId: 'src', sourceSchema: 'public', sourceTable: 'users', targetConnId: 'dst', targetSchema: 'analytics', targetTable: 'users_copy', mode: 'append', mappings: [{ sourceColumn: 'user_id', targetColumn: 'user_id' }, { sourceColumn: 'display_name', targetColumn: 'display_name' }], upsertKeys: undefined, allowDestructive: undefined })
    expect(tableStructure).toHaveBeenCalledTimes(4) // Two previews plus the pre-dispatch recheck.
    await screen.findByText(/Migrated 42 row/i); noReplay()
  })
  it.each(['lost receipt', 'invalid receipt', 'success'])('never replays after %s', async outcome => {
    let resolve!: (value: { rowsTransferred: number }) => void, reject!: (e: Error) => void
    transferTable.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no }))
    mount(); await review(); await run()
    expect(transferTable).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('transfer-target-conn')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('map-user_id')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    await act(async () => { if (outcome === 'lost receipt') reject(new Error('Network disconnected')); else resolve({ rowsTransferred: outcome === 'success' ? 2 : -1 }) })
    if (outcome === 'success') await screen.findByText(/Migrated 2 row/i)
    else await screen.findByText(/Check the target before starting another migration/i)
    noReplay(); expect(transferTable).toHaveBeenCalledTimes(1)
  })
  it('retains a confirmed write receipt when refreshing rejects', async () => {
    mount({ onTransferred: async () => { throw new Error('Refresh failed') } }); await review(); await run()
    await screen.findByText(/Migrated 42 row/i)
    await screen.findByText(/Migration succeeded, but refreshing the view failed/i); noReplay()
  })
  it('blocks duplicate mappings without hiding the reason', async () => {
    mount(); await target(); next()
    fireEvent.change(screen.getByLabelText('map-display_name'), { target: { value: 'user_id' } })
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Multiple source columns')
    expect(transferTable).not.toHaveBeenCalled()
  })
  it('blocks submission while replacement metadata is loading', async () => {
    mount(); await target()
    tableStructure.mockImplementation(() => new Promise(() => {}))
    fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value: 'users' } })
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(transferTable).not.toHaveBeenCalled()
  })
  it('registers busy work and blocks Escape/header/footer close until the actual receipt', async () => {
    let finish!: (value: { rowsTransferred: number }) => void
    transferTable.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const close = vi.fn()
    const view = wrap(<DatabaseWorkProvider owner={{ ownerId: 'owner', workbenchId: 'workbench', profileId: 'src' }}><DataTransferDialog connections={connections} initialSourceConnId="src" initialSourceTable="users" onClose={close}/></DatabaseWorkProvider>)
    await review(); await run()
    expect(hasBusyDatabaseDraftWork({ workbenchId: 'workbench' })).toBe(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    screen.getAllByRole('button', { name: 'Close' }).forEach(button => { expect(button).toBeDisabled(); fireEvent.click(button) })
    expect(close).not.toHaveBeenCalled()
    await act(async () => finish({ rowsTransferred: 2 }))
    expect(hasBusyDatabaseDraftWork({ workbenchId: 'workbench' })).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(close).toHaveBeenCalledTimes(1)
    view.unmount(); expect(hasBusyDatabaseDraftWork({ workbenchId: 'workbench' })).toBe(false)
  })
  it('requires exact destructive confirmation on review and clears it after going back', async () => {
    mount(); await target(); next()
    fireEvent.click(screen.getByRole('button', { name: 'Truncate first' })); next()
    const button = () => screen.getByRole('button', { name: /Migrate 2 column/i })
    expect(button()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('transfer-destructive-confirm'), { target: { value: 'users_copy ' } }); expect(button()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('transfer-destructive-confirm'), { target: { value: 'users_copy' } }); expect(button()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); next()
    expect(screen.getByLabelText('transfer-destructive-confirm')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('transfer-destructive-confirm'), { target: { value: 'users_copy' } }); await run()
    expect(transferTable.mock.calls[0][0]).toMatchObject({ mode: 'overwrite', allowDestructive: true })
  })
  it('does not offer upsert for an unsupported target', async () => {
    mount(); await target(); next()
    expect(screen.getByRole('button', { name: 'Append' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Upsert' })).not.toBeInTheDocument()
  })
  it('requires a mapped key for upsert and preserves it in the reviewed request', async () => {
    mount({ connections: connections.map(c => ({ ...c, engine: 'postgres' })) }); await target(); next()
    fireEvent.click(screen.getByRole('button', { name: 'Upsert' })); expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('upsert-key-user_id')); next(); await run()
    expect(transferTable.mock.calls[0][0]).toMatchObject({ mode: 'upsert', upsertKeys: ['user_id'] })
  })
  it('refuses stale structure before any write and requires a new review', async () => {
    mount(); await review()
    tableStructure.mockResolvedValue({ ...structure, columns: [...columns, { ...columns[1], name: 'added' }] })
    await run()
    await screen.findByText(/structure changed after review/i)
    expect(screen.getByLabelText('transfer-target-table')).toHaveValue('')
    expect(transferTable).not.toHaveBeenCalled()
  })
  it('allows a safe preflight retry when metadata recheck failed before dispatch', async () => {
    mount(); await review()
    tableStructure.mockRejectedValueOnce(new Error('Metadata denied'))
    await run(); await screen.findByText('Metadata denied')
    expect(transferTable).not.toHaveBeenCalled()
    expect(screen.queryByText(/Check the target before starting/i)).not.toBeInTheDocument()
    await run(); expect(transferTable).toHaveBeenCalledTimes(1)
  })
  it('blocks self-copy when the source and target are the same object', async () => {
    mount({ initialSourceSchema: 'analytics' })
    fireEvent.change(screen.getByLabelText('transfer-target-conn'), { target: { value: 'src' } })
    await screen.findByRole('option', { name: 'users' })
    await act(async () => { fireEvent.change(screen.getByLabelText('transfer-target-table'), { target: { value: 'users' } }) })
    expect(screen.getByRole('alert')).toHaveTextContent('Source and target must be different tables')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(transferTable).not.toHaveBeenCalled()
  })
  it('shows source metadata errors and allows explicit reload', async () => {
    tableStructure.mockRejectedValueOnce(new Error('Source denied'))
    mount(); await screen.findByText('Source denied')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload target columns' }))
    await waitFor(() => expect(screen.queryByText('Source denied')).not.toBeInTheDocument())
    await target(); expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })
})
