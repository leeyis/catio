import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DatabaseExportDialog } from './DatabaseExportDialog'

const TABLES = ['orders', 'order_items', 'customers']

function renderDialog(overrides: Omit<Partial<React.ComponentProps<typeof DatabaseExportDialog>>, 'onExport'> = {}) {
  const onExport = vi.fn().mockResolvedValue(undefined)
  const onClose = overrides.onClose ?? vi.fn()
  render(
    <LanguageProvider>
      <DatabaseExportDialog
        schema="public"
        allTables={TABLES}
        onClose={onClose}
        onExport={onExport}
        {...overrides}
      />
    </LanguageProvider>,
  )
  return { onExport, onClose }
}

describe('DatabaseExportDialog', () => {
  it('lists every table, all selected by default', () => {
    renderDialog()
    for (const tbl of TABLES) {
      const cb = screen.getByTestId(`dbexport-tbl:${tbl}`)
      expect(cb).toHaveAttribute('aria-pressed', 'true')
    }
  })

  it('toggling a table deselects it', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('dbexport-tbl:orders'))
    expect(screen.getByTestId('dbexport-tbl:orders')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('dbexport-tbl:customers')).toHaveAttribute('aria-pressed', 'true')
  })

  it('filter narrows the visible table list', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('dbexport-filter'), { target: { value: 'order' } })
    expect(screen.getByTestId('dbexport-tbl:orders')).toBeInTheDocument()
    expect(screen.getByTestId('dbexport-tbl:order_items')).toBeInTheDocument()
    expect(screen.queryByTestId('dbexport-tbl:customers')).not.toBeInTheDocument()
  })

  it('clear-all then a single toggle reduces the export payload to the chosen subset', async () => {
    const { onExport } = renderDialog()
    fireEvent.click(screen.getByTestId('dbexport-clear'))
    fireEvent.click(screen.getByTestId('dbexport-tbl:orders'))
    await act(async () => { fireEvent.click(screen.getByTestId('dbexport-run')) })
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onExport.mock.calls[0][0].selectedTables).toEqual(['orders'])
  })

  it('export button is disabled when no table is selected', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('dbexport-clear'))
    expect(screen.getByTestId('dbexport-run')).toBeDisabled()
  })

  it('export button is disabled when neither structure nor data is included', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('dbexport-opt-structure'))
    fireEvent.click(screen.getByTestId('dbexport-opt-data'))
    expect(screen.getByTestId('dbexport-run')).toBeDisabled()
  })

  it('surfaces a DbError plain-object reason instead of [object Object]', async () => {
    // 回归:Tauri 命令以 { kind, message } reject 时,旧实现用 String(e) → '[object Object]'。
    const onExport = vi.fn().mockRejectedValue({ kind: 'Driver', message: '权限不足:无法读取表结构' })
    render(
      <LanguageProvider>
        <DatabaseExportDialog schema="public" allTables={TABLES} onClose={vi.fn()} onExport={onExport} />
      </LanguageProvider>,
    )
    await act(async () => { fireEvent.click(screen.getByTestId('dbexport-run')) })
    expect(screen.getByText(/权限不足:无法读取表结构/)).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })

  it('passes the chosen options through to onExport', async () => {
    const { onExport } = renderDialog()
    fireEvent.click(screen.getByTestId('dbexport-opt-data')) // turn data OFF (structure-only)
    await act(async () => { fireEvent.click(screen.getByTestId('dbexport-run')) })
    expect(onExport).toHaveBeenCalledTimes(1)
    const arg = onExport.mock.calls[0][0]
    expect(arg.includeStructure).toBe(true)
    expect(arg.includeData).toBe(false)
    // all selected → undefined means "all tables" to the backend
    expect(arg.selectedTables).toBeUndefined()
  })
})
