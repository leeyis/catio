import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DatabaseWorkProvider, hasBusyDatabaseDraftWork } from '../../state/databaseDraftWork'
import i18n from '../../i18n'
import { StructureView } from './StructureView'
import type { TableStructure } from '../../services/types'

const api = vi.hoisted(() => ({ tableStructure: vi.fn(), runQuery: vi.fn(), dropTableChildObject: vi.fn() }))
vi.mock('../../services/db', () => ({ ...api, dbErrMsg: (e: unknown) => String(e instanceof Error ? e.message : e) }))
const structure: TableStructure = {
  comment: 'Orders',
  columns: [
    { name: 'id', type: 'bigint', nullable: false, default: null, key: 'PK', extra: '', comment: '' },
    { name: 'amount', type: 'DECIMAL(28,9)', nullable: true, default: '1.2300', key: '', extra: '', comment: '结算金额' },
  ],
  indexes: [{ name: 'ix_amount', cols: 'amount', unique: false, method: 'btree' }],
  fks: [{ name: 'fk_owner', col: 'id', ref: 'people.id', onDelete: 'RESTRICT', onUpdate: 'NO ACTION' }],
  triggers: [{ name: 'audit_insert', timing: 'AFTER', event: 'INSERT' }],
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const wrap = (node: React.ReactNode) => <LanguageProvider><DataProvider><DatabaseWorkProvider owner={{ ownerId: 'structure-test', workbenchId: 'wb', profileId: 'p' }}>{node}</DatabaseWorkProvider></DataProvider></LanguageProvider>
const view = (table = 'orders') => <StructureView table={table} schema="public" connId="c" engine="postgres" />

beforeEach(async () => { vi.clearAllMocks(); api.tableStructure.mockReset().mockResolvedValue(structure); api.runQuery.mockReset(); api.dropTableChildObject.mockReset(); await i18n.changeLanguage('en') })

describe('Structure workspace', () => {
  it('shows loading instead of a fake empty structure and gates edits until metadata is available', async () => {
    const pending = deferred<TableStructure>(); api.tableStructure.mockReturnValue(pending.promise)
    render(wrap(view()))
    expect(screen.getByRole('status')).toHaveTextContent('Loading structure')
    expect(screen.getByRole('button', { name: 'Add column' })).toBeDisabled()
    expect(screen.queryByText('Columns (0)')).not.toBeInTheDocument()
    await act(async () => pending.resolve(structure))
    expect(screen.getByRole('button', { name: 'Add column' })).toBeEnabled()
  })
  it('filters loaded column metadata by name, type or comment and retains original ordinals', async () => {
    render(wrap(view())); await screen.findByText('amount')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '结算' } })
    expect(screen.queryByText('id', { selector: 'span' })).not.toBeInTheDocument()
    expect(screen.getByText('amount').closest('tr')?.firstChild).toHaveTextContent('2')
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not-found' } })
    expect(screen.getByText('No matching metadata')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear metadata filter' }))
    expect(screen.getByText('id', { selector: 'span' })).toBeInTheDocument()
    expect(api.tableStructure).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['Indexes', 'btree', 'ix_amount'], ['Foreign keys', 'people', 'people.id'], ['Triggers', 'INSERT', 'audit_insert'],
  ])('filters %s without loading rows or executing SQL', async (tab, query, text) => {
    render(wrap(view())); await screen.findByText('amount')
    fireEvent.click(screen.getByText(new RegExp(`^${tab} \\(`)))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } })
    expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add column' })).not.toBeInTheDocument()
    expect(api.runQuery).not.toHaveBeenCalled()
  })
  it('retries a failed metadata request rather than displaying a demo or stale structure', async () => {
    api.tableStructure.mockRejectedValueOnce(new Error('metadata offline'))
    render(wrap(view()))
    expect(await screen.findByRole('alert')).toHaveTextContent('metadata offline')
    expect(screen.queryByText('amount')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add column' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh structure' }))
    expect(await screen.findByText('amount')).toBeInTheDocument()
    expect(api.tableStructure).toHaveBeenCalledTimes(2)
  })
  it('does not show the previous owner metadata while a new target is loading', async () => {
    const pending = deferred<TableStructure>()
    const ui = render(wrap(view())); await screen.findByText('amount')
    api.tableStructure.mockReturnValue(pending.promise)
    ui.rerender(wrap(view('other')))
    expect(screen.queryByText('amount')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add column' })).toBeDisabled()
    await act(async () => pending.resolve({ ...structure, columns: [] }))
  })
  it('labels reconstructed DDL and reports clipboard rejection instead of false copied success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) }, configurable: true })
    render(wrap(view())); await screen.findByText('amount')
    fireEvent.click(screen.getByText('DDL'))
    expect(screen.getByText(/not the original database DDL/)).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Copy DDL'))
    expect(await screen.findByRole('alert')).toHaveTextContent('clipboard denied')
    expect(screen.queryByTitle('Copied')).not.toBeInTheDocument()
  })
  it('registers pending child deletion as busy work and blocks refresh and duplicate confirmations', async () => {
    const pending = deferred<number>(); api.dropTableChildObject.mockReturnValue(pending.promise)
    render(wrap(view())); await screen.findByText('amount')
    fireEvent.click(screen.getByText(/^Indexes/)); fireEvent.click(screen.getByTitle('Drop index'))
    fireEvent.change(screen.getByTestId('child-drop-input'), { target: { value: 'ix_amount' } })
    fireEvent.click(screen.getByTestId('child-drop-confirm'))
    expect(hasBusyDatabaseDraftWork({ ownerId: 'structure-test' })).toBe(true)
    expect(screen.getByRole('button', { name: 'Refresh structure' })).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('child-drop-input'), { key: 'Enter' })
    expect(api.dropTableChildObject).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(0))
    await waitFor(() => expect(hasBusyDatabaseDraftWork({ ownerId: 'structure-test' })).toBe(false))
  })
  it('does not replay an already started multi-statement DDL batch after an error', async () => {
    api.runQuery.mockResolvedValueOnce({ rows: [], columns: [] }).mockRejectedValueOnce(new Error('response lost'))
    render(wrap(view())); await screen.findByText('amount')
    fireEvent.click(screen.getAllByTitle('Edit column')[0])
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'new_id' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/response lost/)
    expect(api.runQuery).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByText(/^Successful statement receipts: 1\./)).toHaveTextContent('Check the database state before preparing another change')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(api.runQuery).toHaveBeenCalledTimes(2)
  })
})
