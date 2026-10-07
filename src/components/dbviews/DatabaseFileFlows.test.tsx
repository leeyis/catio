import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { TableImportDialog } from './TableImportDialog'
import { DatabaseExportDialog } from './DatabaseExportDialog'

const h = vi.hoisted(() => ({ preview: vi.fn(), write: vi.fn(), structure: vi.fn(), open: vi.fn(), previewBytes: vi.fn(), writeBytes: vi.fn() }))
vi.mock('../../services/db', () => ({
  importPreview: h.preview, importTable: h.write, tableStructure: h.structure,
  importPreviewBytes: h.previewBytes, importTableBytes: h.writeBytes,
  dbErrMsg: (e: unknown) => e instanceof Error ? e.message : String(e),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: h.open }))
const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)
const next = () => fireEvent.click(screen.getByTestId('dbflow-next'))
async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
  await screen.findByText('Ada')
}
async function reviewImport() { await choose(); next(); next() }
beforeEach(async () => {
  await i18n.changeLanguage('en'); vi.clearAllMocks(); localStorage.clear()
  h.structure.mockResolvedValue({ columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }] })
  h.open.mockResolvedValue('/qa/rows.csv')
  h.preview.mockResolvedValue({ fileName: 'rows.csv', fileType: 'csv', sizeBytes: 20, columns: ['id', 'name'], rows: [['1', 'Ada']], totalRows: 1, truncated: false })
  h.write.mockResolvedValue({ rowsImported: 1, totalRows: 1 })
})

afterEach(() => { delete (window as unknown as Record<string,unknown>).__CATIO_SERVER__ })

describe('database file workflow gates', () => {
  it('imports exactly the bytes previewed in Web mode and preserves typed preview markers', async () => {
    ;(window as unknown as Record<string,unknown>).__CATIO_SERVER__ = true
    h.previewBytes.mockResolvedValue({fileName:'typed.json',fileType:'json',sizeBytes:20,columns:['id','name'],rows:[['900719925474099312345',''],['0x0001',null]],binaryCells:[[1,0]],totalRows:2,truncated:false})
    h.writeBytes.mockResolvedValue({rowsImported:2,totalRows:2})
    wrap(<TableImportDialog connId="c" table="target" onClose={vi.fn()} />)
    const file = new File(['[]'],'typed.json',{type:'application/json'})
    Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('[]').buffer})
    fireEvent.change(screen.getByTestId('browser-import-file'),{target:{files:[file]}})
    await screen.findByText('900719925474099312345')
    expect(screen.getByText('HEX')).toBeInTheDocument();expect(screen.getByText('(empty string)')).toBeInTheDocument();expect(screen.getByText('NULL')).toBeInTheDocument()
    next();next();fireEvent.click(screen.getByTestId('dbimport-run'))
    await waitFor(()=>expect(h.writeBytes).toHaveBeenCalledTimes(1))
    expect(h.writeBytes.mock.calls[0][0]).toMatchObject(h.previewBytes.mock.calls[0][0])
    expect(h.write).not.toHaveBeenCalled();expect(h.open).not.toHaveBeenCalled()
  })
  it('does not reinterpret a failed refresh callback as a failed import', async () => {
    wrap(<TableImportDialog connId="c" table="target" onClose={vi.fn()} onImported={()=>{throw new Error('refresh offline')}} />)
    await reviewImport();fireEvent.click(screen.getByTestId('dbimport-run'))
    await screen.findByText(/refresh offline/)
    expect(screen.getByTestId('dbflow-receipt')).toHaveTextContent('Imported 1 row')
    expect(screen.queryByTestId('dbimport-run')).not.toBeInTheDocument()
  })
  it('does not expand a reviewed export when the parent catalog changes', async () => {
    const onExport=vi.fn().mockResolvedValue({kind:'saved',name:'main.sql'})
    const ui=wrap(<DatabaseExportDialog schema="main" allTables={['one']} onExport={onExport} onClose={vi.fn()}/>)
    next()
    ui.rerender(<LanguageProvider><DatabaseExportDialog schema="main" allTables={['one','new_table']} onExport={onExport} onClose={vi.fn()}/></LanguageProvider>)
    fireEvent.click(screen.getByTestId('dbexport-run'))
    await waitFor(()=>expect(onExport).toHaveBeenCalledTimes(1))
    expect(onExport.mock.calls[0][0].selectedTables).toEqual(['one'])
  })
  it('requires review and keeps the receipt instead of exposing a second import', async () => {
    const done = vi.fn()
    wrap(<TableImportDialog connId="c" schema="main" table="target" onClose={vi.fn()} onImported={done} />)
    expect(screen.getByTestId('dbflow-next')).toBeDisabled()
    await choose(); expect(h.write).not.toHaveBeenCalled(); next()
    expect(screen.getByLabelText('Map id')).toHaveValue('id')
    next(); expect(h.write).not.toHaveBeenCalled()
    expect(screen.getByTestId('dbimport-review')).toHaveTextContent('main.target')
    fireEvent.click(screen.getByTestId('dbimport-run'))
    await waitFor(() => expect(done).toHaveBeenCalledWith(1))
    expect(screen.getByTestId('dbflow-receipt')).toHaveTextContent('Imported 1 row')
    expect(screen.queryByTestId('dbimport-run')).not.toBeInTheDocument()
  })
  it('does not allow duplicate target mappings to advance to review', async () => {
    wrap(<TableImportDialog connId="c" table="target" onClose={vi.fn()} />)
    await choose(); next()
    fireEvent.change(screen.getByLabelText('Map name'), { target: { value: 'id' } })
    expect(screen.getByTestId('dbflow-next')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/same target column/)
    expect(h.write).not.toHaveBeenCalled()
  })
  it('requires readable target metadata and lets the user retry it', async () => {
    h.structure.mockRejectedValueOnce(new Error('metadata offline'))
    wrap(<TableImportDialog connId="c" table="target" onClose={vi.fn()} />)
    await choose()
    expect(screen.getByTestId('dbflow-next')).toBeDisabled()
    expect(screen.getByText(/metadata offline/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload target columns' }))
    await waitFor(() => expect(screen.getByTestId('dbflow-next')).toBeEnabled())
  })
  it('locks dismissal and prevents duplicate execution, then blocks replay of an uncertain write', async () => {
    let fail!: (reason: Error) => void
    h.write.mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
    const close = vi.fn()
    wrap(<TableImportDialog connId="c" table="target" onClose={close} />)
    await reviewImport()
    const run = screen.getByTestId('dbimport-run')
    act(() => { fireEvent.click(run); fireEvent.click(run) })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByTestId('dbflow-backdrop'))
    expect(close).not.toHaveBeenCalled(); expect(h.write).toHaveBeenCalledTimes(1)
    await act(async () => fail(new Error('connection lost')))
    expect(screen.getByTestId('dbflow-receipt')).toHaveTextContent(/Check the target database/)
    expect(screen.queryByTestId('dbimport-run')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dbflow-back')).not.toBeInTheDocument()
  })
  it('ignores a late file preview belonging to the previous target', async () => {
    let resolve!: (p: unknown) => void
    h.preview.mockReturnValue(new Promise(r => { resolve = r }))
    const ui = wrap(<TableImportDialog connId="c" table="old" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
    await waitFor(() => expect(h.preview).toHaveBeenCalledTimes(1))
    ui.rerender(<LanguageProvider><TableImportDialog connId="other" table="new" onClose={vi.fn()} /></LanguageProvider>)
    await act(async () => resolve({ fileName: 'late.csv', columns: ['id'], rows: [[1]], totalRows: 1, fileType: 'csv' }))
    expect(screen.queryByText(/late.csv/)).not.toBeInTheDocument()
    expect(screen.getByTestId('dbflow-next')).toBeDisabled()
  })
  it('keeps the existing preview when the native file picker is cancelled', async () => {
    wrap(<TableImportDialog connId="c" table="target" onClose={vi.fn()} />)
    await choose(); h.open.mockResolvedValue(null)
    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
    await waitFor(() => expect(screen.getByTestId('dbflow-next')).toBeEnabled())
    expect(screen.getByText('Ada')).toBeInTheDocument()
  })
  it('requires export review and keeps the reviewed table list explicit', async () => {
    const onExport = vi.fn().mockResolvedValue({ kind: 'download', name: 'main.sql' })
    wrap(<DatabaseExportDialog schema="main" allTables={['one','two']} onClose={vi.fn()} onExport={onExport} />)
    next(); expect(onExport).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dbexport-run'))
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1))
    expect(onExport.mock.calls[0][0].selectedTables).toEqual(['one','two'])
    expect(screen.getByTestId('dbflow-receipt')).toHaveTextContent(/Download requested/)
    expect(screen.queryByTestId('dbexport-run')).not.toBeInTheDocument()
  })
  it('rejects invalid export limits instead of silently exporting unlimited rows', () => {
    wrap(<DatabaseExportDialog schema="main" allTables={['one']} onClose={vi.fn()} onExport={vi.fn()} />)
    for (const bad of ['-1','0','1.5','9007199254740992']) {
      fireEvent.change(screen.getByTestId('dbexport-rowlimit'), { target: { value: bad } })
      expect(screen.getByTestId('dbflow-next')).toBeDisabled()
    }
  })
  it('keeps export pending until its real outcome and does not call cancelled a success', async () => {
    let resolve!: (value: { kind: 'cancelled' }) => void
    const onExport = vi.fn(() => new Promise<{kind:'cancelled'}>(r => { resolve = r })), onClose = vi.fn()
    wrap(<DatabaseExportDialog schema="main" allTables={['one']} onClose={onClose} onExport={onExport} />)
    next(); fireEvent.click(screen.getByTestId('dbexport-run'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByTestId('dbflow-backdrop'))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolve({kind:'cancelled'}))
    expect(screen.getByTestId('dbflow-receipt')).toHaveTextContent(/Save cancelled/)
    expect(screen.getByTestId('dbflow-receipt')).not.toHaveTextContent(/saved successfully/)
  })
})
