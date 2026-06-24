import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { DataGrid } from './DataGrid'
import type { ResultColumn } from '../../services/types'

// Mock the db service so the preview/apply flow is exercised without Tauri.
const previewDml = vi.fn()
const applyEdits = vi.fn()
const queryPage = vi.fn()
const tablePreview = vi.fn()
const tableQuery = vi.fn()
const exportFile = vi.fn()
const exportXlsx = vi.fn()
vi.mock('../../services/db', () => ({
  previewDml: (...a: unknown[]) => previewDml(...a),
  applyEdits: (...a: unknown[]) => applyEdits(...a),
  queryPage: (...a: unknown[]) => queryPage(...a),
  tablePreview: (...a: unknown[]) => tablePreview(...a),
  tableQuery: (...a: unknown[]) => tableQuery(...a),
  exportFile: (...a: unknown[]) => exportFile(...a),
  exportXlsx: (...a: unknown[]) => exportXlsx(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const dialogSave = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...a: unknown[]) => dialogSave(...a) }))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('DataGrid generic rows', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { previewDml.mockReset(); applyEdits.mockReset(); queryPage.mockReset(); tablePreview.mockReset(); tableQuery.mockReset(); exportFile.mockReset() })

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

  it('right-click on a cell opens a context menu with Copy and (when editable) Bulk edit', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    // 右键 "alice" 单元格 → 上下文菜单出现，含「复制」与「批量编辑」
    fireEvent.contextMenu(screen.getByText('alice'))
    const menu = screen.getByRole('menu')
    expect(menu).toBeInTheDocument()
    expect(within(menu).getByText('Copy')).toBeInTheDocument()
    expect(within(menu).getByText(/Bulk edit/i)).toBeInTheDocument()
  })

  it('Copy from the context menu writes the selected cell text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    fireEvent.contextMenu(screen.getByText('bob'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('bob'))
  })

  it('shift-clicking row numbers selects a range; Delete rows marks them for deletion', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'a'], [2, 'b'], [3, 'c']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    // 行号单元格带 data-row-select 钩子；点首行再 shift+点末行 → 选中 3 行
    const rowSel = document.querySelectorAll('[data-row-select]')
    expect(rowSel.length).toBe(3)
    fireEvent.click(rowSel[0])
    fireEvent.click(rowSel[2], { shiftKey: true })
    // 右键任一选中行 → 菜单「删除选中行」对 3 行生效（删除计数圆点 tooltip 显示 3）
    fireEvent.contextMenu(rowSel[1])
    fireEvent.click(within(screen.getByRole('menu')).getByText(/Delete .*rows?/i))
    expect(screen.getByTitle('3 deleted')).toBeInTheDocument()
  })

  it('row-number "View detail" button does not cover the whole row-number cell (must be icon-sized)', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'a'], [2, 'b']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    const btn = screen.getAllByTitle('View detail')[0] as HTMLElement
    // codex P2-1: 悬浮态 pointer-events:auto 时,inset:0 + 100% 尺寸会铺满行号单元格,
    // 拦截「点行号选行」。修复后按钮应缩到图标尺寸,不再 inset:0/100% 铺满整格。
    expect(btn.style.width).not.toBe('100%')
    expect(btn.style.height).not.toBe('100%')
    expect(btn.style.inset).not.toBe('0px')
    expect(btn.style.inset).not.toBe('0')
  })

  it('multi-cell Copy reflects pending edits, not the original values', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'a'], [2, 'b']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    // 先编辑 (row0,name) a→A2(pending edit,未保存)
    fireEvent.doubleClick(screen.getByText('a'))
    const input = screen.getByDisplayValue('a')
    fireEvent.change(input, { target: { value: 'A2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // 选中 name 列两行的矩形:点 A2 再 shift+点 b(在网格体内取,避免状态栏回显歧义)
    const grid = document.querySelector('.scrollon') as HTMLElement
    fireEvent.click(within(grid).getByText('A2'))
    fireEvent.click(within(grid).getByText('b'), { shiftKey: true })
    fireEvent.contextMenu(within(grid).getByText('b'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Copy'))
    // codex P2-2: 复制应反映 pending edit 后的 A2,而非原始值 a
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('A2\nb'))
  })

  it('Copy from a row-header right-click copies the selected rows, not the last single cell', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'a'], [2, 'b'], [3, 'c']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    const rowSel = document.querySelectorAll('[data-row-select]')
    // 先单格点一下 (留一个 selCell 残影),再做行多选
    fireEvent.click(screen.getByText('c'))
    fireEvent.click(rowSel[0])
    fireEvent.click(rowSel[1], { shiftKey: true })
    fireEvent.contextMenu(rowSel[0])
    fireEvent.click(within(screen.getByRole('menu')).getByText('Copy'))
    // codex P2-3: 行多选场景复制应拼接选中行 (前两行的整行 TSV),而非残留的单格 'c'
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1\ta\n2\tb'))
  })

  it('Bulk edit dialog writes the same value into every selected cell as pending edits', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'a'], [2, 'b'], [3, 'c']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    // 在 name 列选一个范围：点 (row0,name) 再 shift+点 (row2,name)
    fireEvent.click(screen.getByText('a'))
    fireEvent.click(screen.getByText('c'), { shiftKey: true })
    fireEvent.contextMenu(screen.getByText('b'))
    fireEvent.click(within(screen.getByRole('menu')).getByText(/Bulk edit/i))
    const input = screen.getByPlaceholderText(/value/i)
    fireEvent.change(input, { target: { value: 'ZZZ' } })
    fireEvent.click(screen.getByText(/^Apply$/i))
    // 三行 name 单元格都变为 ZZZ（在网格体内计数，状态栏的选中格回显不计入）
    const grid = document.querySelector('.scrollon') as HTMLElement
    expect(within(grid).getAllByText('ZZZ').length).toBe(3)
    expect(screen.getByTitle('3 edited')).toBeInTheDocument()
  })

  it('range Copy skips a hidden column sitting between two visible columns', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
      { name: 'email', type: 'text' },
    ]
    const rows: unknown[][] = [[10, 'alice', 'a@x.io'], [20, 'bob', 'b@x.io']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    // 隐藏中间的 name 列:点眼睛图标 → 点 name 复选项
    fireEvent.click(screen.getByTitle('Column visibility'))
    fireEvent.click(within(screen.getByRole('menuitemcheckbox', { name: /name/i })).getByText('name'))
    fireEvent.click(screen.getByTitle('Column visibility')) // 关闭菜单
    // 在网格体内做矩形选择:点 id 单元格 '10' → shift+点 email 单元格 'a@x.io'
    const grid = document.querySelector('.scrollon') as HTMLElement
    fireEvent.click(within(grid).getByText('10'))
    fireEvent.click(within(grid).getByText('a@x.io'), { shiftKey: true })
    fireEvent.contextMenu(within(grid).getByText('a@x.io'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('Copy'))
    // 隐藏的 name 列('alice')不应混入复制内容 —— 只拼接可见的 id + email
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('10\ta@x.io'))
  })

  it('Bulk edit skips a hidden column sitting between two visible columns', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
      { name: 'email', type: 'text' },
    ]
    const rows: unknown[][] = [[10, 'alice', 'a@x.io'], [20, 'bob', 'b@x.io']]
    wrap(<DataGrid columns={columns} rows={rows} writable connId="c1" table="orders" />)
    // 隐藏中间的 name 列
    fireEvent.click(screen.getByTitle('Column visibility'))
    fireEvent.click(within(screen.getByRole('menuitemcheckbox', { name: /name/i })).getByText('name'))
    fireEvent.click(screen.getByTitle('Column visibility'))
    // 选中跨越隐藏列的矩形:row0 的 id → row0 的 email
    const grid = document.querySelector('.scrollon') as HTMLElement
    fireEvent.click(within(grid).getByText('10'))
    fireEvent.click(within(grid).getByText('a@x.io'), { shiftKey: true })
    fireEvent.contextMenu(within(grid).getByText('a@x.io'))
    fireEvent.click(within(screen.getByRole('menu')).getByText(/Bulk edit/i))
    const input = screen.getByPlaceholderText(/value/i)
    fireEvent.change(input, { target: { value: 'ZZZ' } })
    fireEvent.click(screen.getByText(/^Apply$/i))
    // 重新显示全部列,核对隐藏的 name 列('alice')未被批量编辑波及。
    fireEvent.click(screen.getByTitle('Column visibility'))
    fireEvent.click(screen.getByText('Show all columns'))
    const body = document.querySelector('.scrollon') as HTMLElement
    // 可见的 id + email 被改为 ZZZ(2 处);隐藏期间被跨越的 name 仍是 'alice'。
    expect(within(body).getAllByText('ZZZ').length).toBe(2)
    expect(within(body).getByText('alice')).toBeInTheDocument()
  })

  it('column filter builder filters the grid by a structured rule', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob'], [3, 'carol']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    // 打开筛选 → 添加一条规则 → name equals bob
    fireEvent.click(screen.getByTitle('Filter'))
    fireEvent.click(screen.getByText('Add condition'))
    fireEvent.change(screen.getByLabelText('filter-column'), { target: { value: 'name' } })
    fireEvent.change(screen.getByLabelText('filter-mode'), { target: { value: 'equals' } })
    fireEvent.change(screen.getByLabelText('filter-value'), { target: { value: 'bob' } })
    const grid = document.querySelector('.scrollon') as HTMLElement
    expect(within(grid).getByText('bob')).toBeInTheDocument()
    expect(within(grid).queryByText('alice')).toBeNull()
    expect(within(grid).queryByText('carol')).toBeNull()
  })

  it('is-null filter hides the value input and keeps null rows', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'note', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'x'], [2, null], [3, 'y']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    fireEvent.click(screen.getByTitle('Filter'))
    fireEvent.click(screen.getByText('Add condition'))
    fireEvent.change(screen.getByLabelText('filter-column'), { target: { value: 'note' } })
    fireEvent.change(screen.getByLabelText('filter-mode'), { target: { value: 'is-null' } })
    // is-null 不需要值输入框
    expect(screen.queryByLabelText('filter-value')).toBeNull()
    const grid = document.querySelector('.scrollon') as HTMLElement
    expect(within(grid).queryByText('x')).toBeNull()
    expect(within(grid).queryByText('y')).toBeNull()
    // null 行(id=2)仍在
    expect(within(grid).getByText('2')).toBeInTheDocument()
  })

  it('Export → SQL writes batched INSERT statements for the displayed rows', async () => {
    // T13: SQL 导出选项 —— 把当前显示行渲染成 INSERT 语句,经 exportFile 落盘。
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    dialogSave.mockReset()
    dialogSave.mockResolvedValue('/tmp/export.sql')
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, "O'Hara"]]
    wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" engine="postgres" />)

    // 打开导出菜单 → 出现 SQL 选项
    fireEvent.click(screen.getByText('Export'))
    const sqlBtn = screen.getByText('SQL')
    expect(sqlBtn).toBeInTheDocument()
    fireEvent.click(sqlBtn)

    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1))
    const [path, contents] = exportFile.mock.calls[0] as [string, string]
    expect(path).toBe('/tmp/export.sql')
    expect(contents).toContain('INSERT INTO "orders" ("id", "name") VALUES (1, \'alice\');')
    // 单引号转义为加倍单引号(对齐 dml.rs)
    expect(contents).toContain("(2, 'O''Hara')")
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('S2: Markdown 导出 —— 当前显示行渲染成管道表格,经 exportFile 落盘', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    dialogSave.mockReset()
    dialogSave.mockResolvedValue('/tmp/export.md')
    exportFile.mockReset()
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'a|b'], [2, 'x']]
    wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" engine="postgres" />)

    fireEvent.click(screen.getByText('Export'))
    const mdBtn = screen.getByText('Markdown')
    expect(mdBtn).toBeInTheDocument()
    fireEvent.click(mdBtn)

    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1))
    const [path, contents] = exportFile.mock.calls[0] as [string, string]
    expect(path).toBe('/tmp/export.md')
    expect(contents).toContain('| id  | name')
    expect(contents).toContain('| --- |')
    // 管道符转义为 \|
    expect(contents).toContain('a\\|b')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('S2: Excel 导出 —— 二进制走后端 exportXlsx(列/行/sheetName/path)而非 exportFile', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    dialogSave.mockReset()
    dialogSave.mockResolvedValue('/tmp/export.xlsx')
    exportFile.mockReset()
    exportXlsx.mockReset()
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" engine="postgres" />)

    fireEvent.click(screen.getByText('Export'))
    const xlsxBtn = screen.getByText('Excel')
    expect(xlsxBtn).toBeInTheDocument()
    fireEvent.click(xlsxBtn)

    await waitFor(() => expect(exportXlsx).toHaveBeenCalledTimes(1))
    expect(exportFile).not.toHaveBeenCalled()
    const [arg] = exportXlsx.mock.calls[0] as [{ columns: string[]; rows: unknown[][]; sheetName?: string; path: string }]
    expect(arg.path).toBe('/tmp/export.xlsx')
    expect(arg.columns).toEqual(['id', 'name'])
    expect(arg.rows).toEqual([[1, 'alice'], [2, 'bob']])
    expect(arg.sheetName).toBe('orders')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('列显隐:勾选切换可隐藏单列,头部不再渲染该列名', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
      { name: 'note', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice', 'x'], [2, 'bob', 'y']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)

    const header = document.querySelector('[data-grid-header]') as HTMLElement
    expect(within(header).getByText('note')).toBeInTheDocument()

    // 打开列显隐菜单 → 在菜单内点击 note 隐藏它
    fireEvent.click(screen.getByTitle('Column visibility'))
    const menuNote = screen.getAllByText('note').find(el => el.closest('[role="menuitemcheckbox"]'))!
    fireEvent.click(menuNote)

    // 头部不再有 note 列(其余列仍在)
    expect(within(header).queryByText('note')).toBeNull()
    expect(within(header).getByText('name')).toBeInTheDocument()
  })

  it('列显隐:一键隐藏空列只隐藏整列为 NULL 的列', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
      { name: 'empty', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice', null], [2, 'bob', null]]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)

    const header = document.querySelector('[data-grid-header]') as HTMLElement
    expect(within(header).getByText('empty')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Column visibility'))
    fireEvent.click(screen.getByText('Hide empty columns'))

    expect(within(header).queryByText('empty')).toBeNull()
    expect(within(header).getByText('name')).toBeInTheDocument()
    expect(within(header).getByText('id')).toBeInTheDocument()
  })

  // ── 服务端 WHERE / ORDER BY ────────────────────────────────────────────────
  describe('服务端 WHERE / ORDER BY', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]

    it('livePreview 下显示 WHERE / ORDER BY 输入框', () => {
      wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" schema="public" livePreview />)
      expect(screen.getByPlaceholderText('WHERE')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('ORDER BY')).toBeInTheDocument()
    })

    it('非 livePreview(SQL 结果或 mock)不显示 WHERE / ORDER BY 输入框', () => {
      wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} />)
      expect(screen.queryByPlaceholderText('WHERE')).toBeNull()
      expect(screen.queryByPlaceholderText('ORDER BY')).toBeNull()
    })

    it('WHERE 输入框聚焦后弹出字段/关键字候选,点击列名插入', () => {
      wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" schema="public" livePreview />)
      const where = screen.getByPlaceholderText('WHERE') as HTMLInputElement
      fireEvent.focus(where)
      // 候选含列名(id/name)与 WHERE 关键字(AND);点击列名插入到输入框。
      const idOpt = screen.getAllByText('id').find(el => el.closest('button'))!
      expect(idOpt).toBeTruthy()
      expect(screen.getByText('AND')).toBeInTheDocument()
      fireEvent.mouseDown(idOpt)
      expect(where.value).toBe('id')
    })

    it('拖拽表头字段名到 WHERE 输入框,在光标处插入列名', () => {
      wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" schema="public" livePreview />)
      const where = screen.getByPlaceholderText('WHERE') as HTMLInputElement
      const dt = { getData: (t: string) => (t === 'text/plain' ? 'name' : ''), setData: () => {}, effectAllowed: '' }
      fireEvent.drop(where, { dataTransfer: dt })
      expect(where.value).toBe('name')
    })

    it('非 SQL 引擎(mongodb/redis/es)即使 livePreview 也不显示 WHERE / ORDER BY 输入框', () => {
      // 这类引擎不支持 SQL WHERE/ORDER BY,后端会拒绝;前端按 engine 直接隐藏,避免误导。
      for (const engine of ['mongodb', 'redis', 'elasticsearch']) {
        const { unmount } = wrap(
          <DataGrid columns={columns} rows={rows} connId="c1" table="orders" schema="db" engine={engine} livePreview />,
        )
        expect(screen.queryByPlaceholderText('WHERE')).toBeNull()
        expect(screen.queryByPlaceholderText('ORDER BY')).toBeNull()
        unmount()
      }
    })

    it('提交 WHERE / ORDER BY 经服务端 tableQuery 重查并渲染返回行', async () => {
      tableQuery.mockResolvedValue({
        columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }],
        rows: [[2, 'bob']],
      })
      wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" schema="public" livePreview />)

      const where = screen.getByPlaceholderText('WHERE')
      fireEvent.change(where, { target: { value: "name = 'bob'" } })
      const order = screen.getByPlaceholderText('ORDER BY')
      fireEvent.change(order, { target: { value: 'id DESC' } })
      // Enter 触发服务端重查(从首页 offset=0 开始)。
      fireEvent.keyDown(where, { key: 'Enter' })

      await waitFor(() => expect(tableQuery).toHaveBeenCalled())
      const call = tableQuery.mock.calls[0]
      // (connId, schema, table, whereClause, orderBy, limit, offset)
      expect(call[0]).toBe('c1')
      expect(call[1]).toBe('public')
      expect(call[2]).toBe('orders')
      expect(call[3]).toBe("name = 'bob'")
      expect(call[4]).toBe('id DESC')
      expect(call[6]).toBe(0)
      // 返回的服务端行替换网格内容
      expect(await screen.findByText('bob')).toBeInTheDocument()
      expect(screen.queryByText('alice')).toBeNull()
    })

    it('清空 WHERE/ORDER BY 提交回落 tablePreview(无条件全量)', async () => {
      tablePreview.mockResolvedValue({
        columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }],
        rows: [[1, 'alice'], [2, 'bob']],
      })
      wrap(<DataGrid columns={columns} rows={rows} connId="c1" table="orders" schema="public" livePreview />)
      const where = screen.getByPlaceholderText('WHERE')
      // 提交空 WHERE(无条件):走 tablePreview,不走 tableQuery。
      fireEvent.keyDown(where, { key: 'Enter' })
      await waitFor(() => expect(tablePreview).toHaveBeenCalled())
      expect(tableQuery).not.toHaveBeenCalled()
    })
  })
})
