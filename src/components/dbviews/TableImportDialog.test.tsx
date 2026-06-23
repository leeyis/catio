import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { TableImportDialog } from './TableImportDialog'

// Mock the db service so the dialog runs without the Tauri runtime.
const importPreview = vi.fn()
const importTable = vi.fn()
const tableStructure = vi.fn()
vi.mock('../../services/db', () => ({
  importPreview: (...a: unknown[]) => importPreview(...a),
  importTable: (...a: unknown[]) => importTable(...a),
  tableStructure: (...a: unknown[]) => tableStructure(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const dialogOpen = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a: unknown[]) => dialogOpen(...a) }))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('TableImportDialog', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => {
    importPreview.mockReset(); importTable.mockReset(); tableStructure.mockReset(); dialogOpen.mockReset()
    tableStructure.mockResolvedValue({
      comment: '', indexes: [], fks: [],
      columns: [
        { name: 'user_id', type: 'int', nullable: false, default: null, key: 'PK', extra: '', comment: '' },
        { name: 'display_name', type: 'text', nullable: true, default: null, key: '', extra: '', comment: '' },
      ],
    })
  })

  it('previews a chosen file, auto-maps columns, and imports with the mapped pairs', async () => {
    dialogOpen.mockResolvedValue('/data/users.csv')
    importPreview.mockResolvedValue({
      fileName: 'users.csv', fileType: 'csv', sizeBytes: 100,
      columns: ['user_id', 'display_name'],
      rows: [['1', 'Ada'], ['2', 'Linus']],
      totalRows: 2, truncated: false,
    })
    importTable.mockResolvedValue({ rowsImported: 2, totalRows: 2 })

    wrap(<TableImportDialog connId="c1" schema="public" table="users" onClose={() => {}} />)

    // Import button is disabled before a file is loaded.
    const applyBtn = screen.getByRole('button', { name: /Import \d+ column/i })
    expect(applyBtn).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))

    // After preview loads, the file summary + preview rows appear.
    await waitFor(() => expect(screen.getByText(/users\.csv/)).toBeInTheDocument())
    expect(screen.getByText('Ada')).toBeInTheDocument()

    // Auto-map matched both columns exactly → import enabled, mapping count = 2.
    const apply2 = await screen.findByRole('button', { name: /Import 2 column/i })
    expect(apply2).not.toBeDisabled()

    fireEvent.click(apply2)

    await waitFor(() => expect(importTable).toHaveBeenCalledTimes(1))
    expect(importTable).toHaveBeenCalledWith({
      connId: 'c1', schema: 'public', table: 'users', filePath: '/data/users.csv',
      mode: 'append',
      mappings: [
        { sourceColumn: 'user_id', targetColumn: 'user_id' },
        { sourceColumn: 'display_name', targetColumn: 'display_name' },
      ],
    })
    // Success summary shown.
    await waitFor(() => expect(screen.getByText(/Imported 2 row/i)).toBeInTheDocument())
  })

  it('skips unmapped source columns and passes truncate mode', async () => {
    dialogOpen.mockResolvedValue('/data/x.csv')
    importPreview.mockResolvedValue({
      fileName: 'x.csv', fileType: 'csv', sizeBytes: 50,
      columns: ['user_id', 'junk'],
      rows: [['1', 'z']],
      totalRows: 1, truncated: false,
    })
    importTable.mockResolvedValue({ rowsImported: 1, totalRows: 1 })

    wrap(<TableImportDialog connId="c1" schema="public" table="users" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
    await waitFor(() => expect(screen.getByText(/x\.csv/)).toBeInTheDocument())

    // "junk" has no matching target → only 1 mapped column.
    const apply1 = await screen.findByRole('button', { name: /Import 1 column/i })
    expect(apply1).not.toBeDisabled()

    // Switch to truncate mode.
    fireEvent.click(screen.getByRole('button', { name: /Truncate first/i }))
    fireEvent.click(apply1)

    await waitFor(() => expect(importTable).toHaveBeenCalledTimes(1))
    const arg = importTable.mock.calls[0][0]
    expect(arg.mode).toBe('truncate')
    expect(arg.mappings).toEqual([{ sourceColumn: 'user_id', targetColumn: 'user_id' }])
  })

  it('surfaces a preview error', async () => {
    dialogOpen.mockResolvedValue('/data/bad.xlsx')
    importPreview.mockRejectedValue(new Error('Excel import not supported'))

    wrap(<TableImportDialog connId="c1" table="users" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))

    await waitFor(() => expect(screen.getByText(/Excel import not supported/)).toBeInTheDocument())
    expect(importTable).not.toHaveBeenCalled()
  })
})
