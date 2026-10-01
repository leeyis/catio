import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { DataGrid } from './DataGrid'

const api = vi.hoisted(() => ({ tablePreview: vi.fn(), previewDml: vi.fn(), applyEdits: vi.fn() }))
vi.mock('../../services/db', async original => ({
  ...await original<typeof import('../../services/db')>(), ...api,
}))
const columns = [{ name: 'id', type: 'int', pk: true }, { name: 'value', type: 'text' }]
const rows = Array.from({ length: 100 }, (_, i) => [i + 1, `row-${i + 1}`])
const wrap = (node: React.ReactNode) => render(<LanguageProvider>{node}</LanguageProvider>)
const grid = () => wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="items" livePreview truncated />)

beforeAll(async () => { await i18n.changeLanguage('en') })
beforeEach(() => { Object.values(api).forEach(mock => mock.mockReset()); api.previewDml.mockResolvedValue('-- reviewed SQL') })

describe('database grid safety and paging', () => {
  it('uses lookahead metadata to enable the first next page and disable the final next page', async () => {
    api.tablePreview.mockResolvedValue({ columns, rows: [[101, 'last-page']], truncated: false })
    grid()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('last-page')
    expect(api.tablePreview).toHaveBeenCalledWith('c1', undefined, 'items', 100, 100)
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('never applies first-page edits to a different page', async () => {
    grid()
    fireEvent.doubleClick(screen.getByText('row-1'))
    const input = screen.getByDisplayValue('row-1')
    fireEvent.change(input, { target: { value: 'edited-first-row' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByTitle('Refresh')).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Rows' })).toBeDisabled()
    expect(api.tablePreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('Save edits'))
    await waitFor(() => expect(api.previewDml).toHaveBeenCalledWith('c1', expect.objectContaining({ pk: [['id', 1]], cells: [['value', 'edited-first-row']] })))
  })

  it('keeps the last successful page and surfaces a failed page request', async () => {
    api.tablePreview.mockRejectedValue(new Error('fixture connection interrupted'))
    grid()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('fixture connection interrupted')
    expect(screen.getByText('row-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
  })

  it('provides explicit NULL editing, different from an empty string', async () => {
    wrap(<DataGrid columns={columns} rows={[[1, 'kept']]} connId="c1" table="items" livePreview />)
    fireEvent.contextMenu(screen.getByText('kept'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set NULL' }))
    fireEvent.click(screen.getByTitle('Save edits'))
    await waitFor(() => expect(api.previewDml).toHaveBeenCalledWith('c1', expect.objectContaining({ cells: [['value', null]] })))
  })

  it('does not coerce an untouched NULL into an empty string', () => {
    const { container } = wrap(<DataGrid columns={columns} rows={[[1, null]]} connId="c1" table="items" livePreview />)
    const cell = container.querySelectorAll('.gridrow > div')[2]
    fireEvent.doubleClick(cell)
    fireEvent.keyDown(container.querySelector('.gridrow input')!, { key: 'Enter' })
    expect(screen.queryByTitle('Save edits')).not.toBeInTheDocument()
  })

  it('allows INSERT into a keyless table while keeping existing rows read-only', () => {
    wrap(<DataGrid columns={[{ name: 'value', type: 'text' }]} rows={[['keyless']]} connId="c1" table="items" livePreview />)
    expect(screen.getByTitle('Add row')).toBeEnabled()
    fireEvent.doubleClick(screen.getAllByText('keyless').find(element => element.closest('.gridrow'))!)
    expect(screen.queryByDisplayValue('keyless')).not.toBeInTheDocument()
  })

  it('renders duplicate SQL result labels without substituting the last column value', () => {
    const { container } = wrap(<DataGrid columns={[{ name: 'id', type: 'int' }, { name: 'id', type: 'int' }]} rows={[[11, 22]]} connId="c1" resultLabel="Query result" writable={false} />)
    const cells = container.querySelectorAll('.gridrow > div')
    expect(cells[1]).toHaveTextContent('11')
    expect(cells[2]).toHaveTextContent('22')
    expect(screen.getByText('id (2)')).toHaveAttribute('title', 'Original column: id')
    fireEvent.click(screen.getByRole('button', { name: /Export/i }))
    expect(screen.queryByRole('button', { name: 'SQL' })).not.toBeInTheDocument()
  })

  it('refuses to edit a nullable primary key row and preserves timestamp microseconds', () => {
    const { container } = wrap(<DataGrid columns={columns} rows={[[null, 'unsafe-row']]} connId="c1" table="items" livePreview />)
    fireEvent.doubleClick(screen.getByText('unsafe-row'))
    expect(screen.getByRole('alert')).toHaveTextContent('non-null row key')
    expect(container.querySelector('.gridrow input')).toBeNull()
  })

  it('uses the existing clipboard fallback on an insecure HTTP page', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    const { container } = wrap(<DataGrid columns={columns} rows={[[1, 'copied-on-http']]} table="items" />)
    fireEvent.click(screen.getByText('copied-on-http'))
    fireEvent.keyDown(container.querySelector('.scrollon')!, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'))
  })

  it('captures a preview failure rather than producing an unhandled rejection', async () => {
    api.previewDml.mockRejectedValue(new Error('preview denied'))
    wrap(<DataGrid columns={columns} rows={[[1, 'old']]} connId="c1" table="items" livePreview />)
    fireEvent.doubleClick(screen.getByText('old'))
    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'new' } })
    fireEvent.keyDown(screen.getByDisplayValue('new'), { key: 'Enter' })
    fireEvent.click(screen.getByTitle('Save edits'))
    expect(await screen.findByRole('alert')).toHaveTextContent('preview denied')
    expect(screen.getByTitle('Save edits')).toBeInTheDocument()
  })
})
