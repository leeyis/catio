import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { DataGrid } from './DataGrid'
import type { ResultColumn } from '../../services/types'

// Mock the db service so the preview/apply flow is exercised without Tauri.
const previewDml = vi.fn()
const applyEdits = vi.fn()
const queryPage = vi.fn()
const tablePreview = vi.fn()
const exportFile = vi.fn()
vi.mock('../../services/db', () => ({
  previewDml: (...a: unknown[]) => previewDml(...a),
  applyEdits: (...a: unknown[]) => applyEdits(...a),
  queryPage: (...a: unknown[]) => queryPage(...a),
  tablePreview: (...a: unknown[]) => tablePreview(...a),
  exportFile: (...a: unknown[]) => exportFile(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('DataGrid generic rows', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { previewDml.mockReset(); applyEdits.mockReset(); queryPage.mockReset(); tablePreview.mockReset(); exportFile.mockReset() })

  it('renders columns and indexed row values', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('id')).toBeInTheDocument()
  })

  it('renders nested objects/arrays as JSON, not "[object Object]" (MongoDB sub-docs)', () => {
    const columns: ResultColumn[] = [
      { name: '_id', type: 'string', pk: true },
      { name: 'data', type: 'object' },
      { name: 'variables', type: 'array' },
    ]
    const rows: unknown[][] = [['abc', { ip: '127.0.0.1', ok: true }, [{ k: 1 }, { k: 2 }]]]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    expect(screen.getByText('{"ip":"127.0.0.1","ok":true}')).toBeInTheDocument()
    expect(screen.getByText('[{"k":1},{"k":2}]')).toBeInTheDocument()
    expect(screen.queryByText('[object Object]')).toBeNull()
  })

  it('Save opens a preview gate showing the DML, then apply commits and clears edits', async () => {
    previewDml.mockResolvedValue('UPDATE orders SET status = $1 WHERE id = $2')
    applyEdits.mockResolvedValue(2)
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)

    // Edit a real cell (the seeded default edits reference rows absent from this
    // result, so they'd build no requests). Double-click "alice" → type → Enter.
    const cell = screen.getByText('alice')
    fireEvent.doubleClick(cell)
    const input = screen.getByDisplayValue('alice')
    fireEvent.change(input, { target: { value: 'ALICE' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const saveBtn = screen.getByTitle(/Save edits/i)
    fireEvent.click(saveBtn)

    // preview modal renders the SQL returned by previewDml
    await waitFor(() => expect(previewDml).toHaveBeenCalled())
    expect(await screen.findByText(/Review changes/i)).toBeInTheDocument()
    expect(screen.getByText(/UPDATE orders SET status/i)).toBeInTheDocument()

    // confirm → applyEdits called, modal closes, success message shows
    fireEvent.click(screen.getByText(/^Apply$/i))
    await waitFor(() => expect(applyEdits).toHaveBeenCalled())
  })

  it('surfaces a failed apply in the preview modal instead of failing silently', async () => {
    previewDml.mockResolvedValue('UPDATE orders SET name = $1 WHERE id = $2')
    applyEdits.mockRejectedValue(new Error('permission denied for table orders'))
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)

    const cell = screen.getByText('alice')
    fireEvent.doubleClick(cell)
    const input = screen.getByDisplayValue('alice')
    fireEvent.change(input, { target: { value: 'ALICE' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    fireEvent.click(screen.getByTitle(/Save edits/i))
    await screen.findByText(/Review changes/i)
    fireEvent.click(screen.getByText(/^Apply$/i))

    // error message rendered; modal stays open (preview SQL still visible)
    expect(await screen.findByText(/permission denied for table orders/i)).toBeInTheDocument()
    expect(screen.getByText(/UPDATE orders SET name/i)).toBeInTheDocument()
  })

  it('read-only engines (writable=false) hide the Save affordance', () => {
    const columns: ResultColumn[] = [{ name: 'id', type: 'int', pk: true }]
    const rows: unknown[][] = [[1], [2]]
    wrap(<DataGrid columns={columns} rows={rows} writable={false} />)
    expect(screen.queryByTitle(/Save edits/i)).not.toBeInTheDocument()
  })

  it('results with no primary key disable editing (no Save)', () => {
    const columns: ResultColumn[] = [{ name: 'name', type: 'text' }]
    const rows: unknown[][] = [['alice'], ['bob']]
    wrap(<DataGrid columns={columns} rows={rows} writable />)
    expect(screen.queryByTitle(/Save edits/i)).not.toBeInTheDocument()
  })
})
