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

  it('copies the selected cell full text on Ctrl+C', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)

    // Select the "alice" cell, then dispatch Ctrl+C on the focusable grid container.
    fireEvent.click(screen.getByText('alice'))
    const grid = document.querySelector('.scrollon') as HTMLElement
    expect(grid).toBeTruthy()
    fireEvent.keyDown(grid, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('alice'))
  })

  it('drag-resizing a column header updates the grid template width', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)

    const handle = screen.getAllByTitle(/resize/i)[0] // 'id' 列的拖动手柄
    const header = document.querySelector('[data-grid-header]') as HTMLElement
    const before = header.style.gridTemplateColumns
    fireEvent.mouseDown(handle, { clientX: 200 })
    fireEvent.mouseMove(document, { clientX: 260 })
    fireEvent.mouseUp(document)
    const after = header.style.gridTemplateColumns
    expect(after).not.toBe(before)
    // 'id' default width is 160 → +60px drag = 220px.
    expect(after).toContain('220px')
  })

  it('reuses the default namespace for raw-query pagination', async () => {
    queryPage.mockResolvedValue({ columns: [{ name: 'id', type: 'int' }], rows: [[101]], truncated: false })
    const columns: ResultColumn[] = [{ name: 'id', type: 'int' }]
    wrap(
      <DataGrid
        columns={columns}
        rows={Array.from({ length: 100 }, (_, i) => [i + 1])}
        connId="c1"
        sql="SELECT id FROM orders ORDER BY id"
        defaultNamespace="dwd"
        truncated
      />,
    )
    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(queryPage).toHaveBeenCalledWith(
      'c1',
      'SELECT id FROM orders ORDER BY id',
      100,
      100,
      'dwd',
    ))
  })

  it('comment toggle: hidden when no column has a comment (e.g. ad-hoc SQL results)', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    expect(screen.queryByTitle(/Show comments/i)).toBeNull()
    expect(screen.queryByTitle(/Show column names/i)).toBeNull()
  })

  it('comment toggle: shown when any column has a comment, and flips header text to comments and back', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true, comment: '主键' },
      { name: 'status', type: 'text' }, // no comment → falls back to name in comment mode
    ]
    const rows: unknown[][] = [[1, 'open']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)

    // default: english names visible, comment not shown as a header
    const header = document.querySelector('[data-grid-header]') as HTMLElement
    expect(header.textContent).toContain('id')
    expect(header.textContent).not.toContain('主键')

    // toggle on → comment mode: 'id' header shows its comment; 'status' (no comment) falls back to name
    fireEvent.click(screen.getByTitle(/Show comments/i))
    const headerOn = document.querySelector('[data-grid-header]') as HTMLElement
    expect(headerOn.textContent).toContain('主键')
    expect(headerOn.textContent).toContain('status')

    // toggle back → english names again
    fireEvent.click(screen.getByTitle(/Show column names/i))
    const headerOff = document.querySelector('[data-grid-header]') as HTMLElement
    expect(headerOff.textContent).toContain('id')
    expect(headerOff.textContent).not.toContain('主键')
  })

  it('comment toggle: long comment is truncated with a title carrying the full text', () => {
    const longComment = '这是一个非常非常非常长的列注释用于验证省略号截断与 title 悬浮显示全文的行为'
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true, comment: longComment },
    ]
    const rows: unknown[][] = [[1]]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    fireEvent.click(screen.getByTitle(/Show comments/i))
    // the comment-mode header label carries the full comment as a title for hover
    const labelled = screen.getByTitle(longComment)
    expect(labelled).toBeInTheDocument()
    expect(labelled.className).toContain('ell')
  })

  it('row detail: opens a vertical detail modal, renders URL values as links, and prev/next navigate within the page', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'site', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'https://example.com'], [2, 'plain value']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    // 每行行号处都有一个"查看明细"按钮
    const detailBtns = screen.getAllByTitle('View detail')
    expect(detailBtns.length).toBe(2)
    fireEvent.click(detailBtns[0])
    // 弹窗标题携带行号；URL 值渲染为可点击链接
    expect(screen.getByText('Row detail[1]')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'https://example.com' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    // 下一条 → 第 2 行，标题变为 [2]，纯文本不是链接
    fireEvent.click(screen.getByTitle('Next'))
    expect(screen.getByText('Row detail[2]')).toBeInTheDocument()
    // 第 2 行没有 URL，明细里不应再出现可点击链接（网格单元格本身不会渲染成链接）
    expect(screen.queryByRole('link')).toBeNull()
  })
})
