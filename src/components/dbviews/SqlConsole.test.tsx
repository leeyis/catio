import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle } from 'react'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SqlConsole } from './SqlConsole'
import { writeHiddenSchemas } from '../../state/schemaFilter'

// CodeMirror 在 jsdom 下难以稳定挂载,且本测试只关心 SqlConsole 自身的分屏/最大化布局,
// 故把 SqlEditor 替换成一个轻量桩件。
// 测试可通过此变量给桩件设定「当前选中文本」,以验证 EXPLAIN 走选中优先逻辑。
let stubSelectedText = ''
vi.mock('./SqlEditor', () => ({
  // 桩件回显 code,使格式化按钮的接线(对编辑器内容做格式化替换)可被断言;
  // 同时暴露 getSelectedText 句柄,模拟用户选中片段的场景。
  SqlEditor: forwardRef<{ getSelectedText: () => string }, { code?: string }>((props, ref) => {
    useImperativeHandle(ref, () => ({
      getSelectedText: () => stubSelectedText,
      insertAtCursor: (t: string) => t,
    }), [])
    return <div data-testid="sql-editor-stub">{props.code}</div>
  }),
}))

// db 服务在非 connId(mock)路径下不会被调用,但 import 时仍需存在。
const runExplainMock = vi.fn(() =>
  Promise.resolve({
    columns: [{ name: 'QUERY PLAN', type: 'json' }],
    rows: [[JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders' } }])]],
  }),
)
// 可按用例覆盖的 getSchema(用于「库/Schema 下拉联动漏斗筛选」测试)。
type StubNs = { name: string; tables: unknown[]; views: unknown[]; functions: unknown[] }
const getSchemaMock = vi.fn(() => Promise.resolve({ schemas: [] as StubNs[] }))

vi.mock('../../services/db', () => ({
  runQuery: vi.fn(),
  runExplain: (...args: unknown[]) => runExplainMock(...(args as [])),
  getSchema: (...args: unknown[]) => getSchemaMock(...(args as [])),
  schemaColumns: vi.fn(() => Promise.resolve([])),
  tablePreview: vi.fn(() => Promise.resolve({ columns: [], rows: [] })),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

describe('SqlConsole 分屏与最大化', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  // fresh 未设 → phase 初始为 'done' → 结果区与最大化按钮立即可见(mock 路径)。
  it('有结果区时显示编辑区/结果区最大化按钮与拖动分隔条', () => {
    wrap(<SqlConsole />)
    expect(screen.getByTitle('Maximize editor')).toBeInTheDocument()
    expect(screen.getByTitle('Maximize results')).toBeInTheDocument()
    // 分隔条以 role=separator + 水平朝向呈现。
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('点击最大化编辑区后:结果区隐藏,按钮变为恢复', () => {
    wrap(<SqlConsole />)
    fireEvent.click(screen.getByTitle('Maximize editor'))
    // maxEditor 态:结果区(及其最大化按钮)隐藏,编辑区按钮变为"恢复"。
    expect(screen.getByTitle('Restore size')).toBeInTheDocument()
    expect(screen.queryByTitle('Maximize results')).toBeNull()
    expect(screen.queryByTitle('Maximize editor')).toBeNull()
    // split 专属的分隔条在最大化态下消失。
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('点击最大化结果区后:结果区按钮变为恢复,分隔条消失', () => {
    wrap(<SqlConsole />)
    fireEvent.click(screen.getByTitle('Maximize results'))
    // 结果区工具条上的按钮变为"恢复";其自身的"最大化结果区"入口消失。
    expect(screen.getByTitle('Restore size')).toBeInTheDocument()
    expect(screen.queryByTitle('Maximize results')).toBeNull()
    // 编辑区工具栏的"最大化编辑区"按钮仍在顶部条上(顶部条始终可见),不受 maxResults 影响。
    expect(screen.getByTitle('Maximize editor')).toBeInTheDocument()
    // split 专属的分隔条消失。
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('恢复后回到 split,两个最大化按钮与分隔条重新出现', () => {
    wrap(<SqlConsole />)
    fireEvent.click(screen.getByTitle('Maximize editor'))
    fireEvent.click(screen.getByTitle('Restore size'))
    expect(screen.getByTitle('Maximize editor')).toBeInTheDocument()
    expect(screen.getByTitle('Maximize results')).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  // 父子契约(功能#6):paneMode !== 'split' 时上报 true,回 split 时上报 false。
  it('paneMode 变化时通过 onFullscreenChange 上报最大化态', () => {
    const onFs = vi.fn()
    wrap(<SqlConsole onFullscreenChange={onFs} />)
    // 初始挂载即上报一次(split → false)。
    expect(onFs).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByTitle('Maximize editor'))
    expect(onFs).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByTitle('Restore size'))
    expect(onFs).toHaveBeenLastCalledWith(false)
  })

  // 拖动分隔条:jsdom 下 getBoundingClientRect().height 为 0,拖动会被 total<=0 早退,
  // 故这里只断言分隔条可接收 mousedown 而不抛错(交互的真实换算留给手动/集成验证)。
  it('分隔条 mousedown 不抛错', () => {
    wrap(<SqlConsole />)
    const bar = screen.getByRole('separator')
    expect(() => fireEvent.mouseDown(bar, { clientY: 100 })).not.toThrow()
  })
})

describe('SqlConsole 格式化按钮接线', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  it('点击格式化按钮:按引擎方言重写编辑器内容(关键字大写、多行缩进)', () => {
    wrap(<SqlConsole fresh engine="postgres" initialCode="select a,b from t where x=1" />)
    fireEvent.click(screen.getByTitle('Format'))
    const stub = screen.getByTestId('sql-editor-stub')
    expect(stub.textContent).toContain('SELECT')
    expect(stub.textContent).toContain('FROM')
    expect(stub.textContent).toMatch(/SELECT\n\s+a,/)
  })

  it('无内容时格式化按钮禁用', () => {
    wrap(<SqlConsole fresh engine="postgres" />)
    expect(screen.getByTitle('Format')).toBeDisabled()
  })

  it('非 SQL 引擎(redis)plain 模式下格式化按钮禁用', () => {
    wrap(<SqlConsole fresh engine="redis" initialCode="GET foo" />)
    expect(screen.getByTitle('Format')).toBeDisabled()
  })
})

describe('SqlConsole 执行计划(EXPLAIN)入口', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { runExplainMock.mockClear(); stubSelectedText = '' })

  it('已连接且引擎支持(postgres)时显示「解释」按钮', () => {
    wrap(<SqlConsole connId="c1" engine="postgres" initialCode="select 1" fresh />)
    expect(screen.getByTitle('Show execution plan')).toBeInTheDocument()
  })

  it('引擎不支持(redis)或未连接时不显示「解释」按钮', () => {
    const { rerender } = wrap(<SqlConsole connId="c1" engine="redis" initialCode="GET k" fresh />)
    expect(screen.queryByTitle('Show execution plan')).toBeNull()
    // 未连接(mock 路径)也不显示。
    rerender(<LanguageProvider><DataProvider><SqlConsole engine="postgres" initialCode="select 1" fresh /></DataProvider></LanguageProvider>)
    expect(screen.queryByTitle('Show execution plan')).toBeNull()
  })

  it('无 SQL 时「解释」按钮禁用', () => {
    wrap(<SqlConsole connId="c1" engine="postgres" fresh />)
    expect(screen.getByTitle('Show execution plan')).toBeDisabled()
  })

  it('点击「解释」调用 runExplain 并渲染执行计划查看器', async () => {
    wrap(<SqlConsole connId="c1" engine="postgres" initialCode="select * from orders" fresh />)
    fireEvent.click(screen.getByTitle('Show execution plan'))
    // 第三参为选中的默认库/Schema:EXPLAIN 必须沿用它(此处 mock 自动选中首个库 public),
    // 否则后端落连接默认库,对未限定库名的查询报「默认库.表 不存在」(真机缺陷)。
    expect(runExplainMock).toHaveBeenCalledWith('c1', 'select * from orders', 'public')
    // 解析后的计划树出现在结果区(节点标题含表名)。
    expect(await screen.findByText('Seq Scan on orders')).toBeInTheDocument()
  })

  it('编辑区有选中片段时「解释」仅对选中的 SQL 取计划(与普通运行选中优先一致)', () => {
    // 多语句编辑区,用户选中其中一条 SELECT —— EXPLAIN 应只对选中文本执行,
    // 而不是对整段 code 运行(否则多语句会拼出非法 EXPLAIN)。
    stubSelectedText = 'select * from orders'
    wrap(<SqlConsole connId="c1" engine="postgres" initialCode="select 1;\nselect * from orders;" fresh />)
    fireEvent.click(screen.getByTitle('Show execution plan'))
    // 第三参为选中的默认库/Schema:EXPLAIN 必须沿用它(此处 mock 自动选中首个库 public),
    // 否则后端落连接默认库,对未限定库名的查询报「默认库.表 不存在」(真机缺陷)。
    expect(runExplainMock).toHaveBeenCalledWith('c1', 'select * from orders', 'public')
  })
})

describe('SqlConsole 库/Schema 下拉联动漏斗筛选', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => {
    localStorage.clear()
    getSchemaMock.mockReset()
  })

  it('被漏斗隐藏的 schema 不出现在默认库/Schema 下拉中', async () => {
    // 真机反馈:结构面板漏斗筛掉的库,SQL 控制台的「默认库/Schema」下拉也只应保留筛选后的。
    getSchemaMock.mockResolvedValue({
      schemas: [
        { name: 'public', tables: [], views: [], functions: [] },
        { name: 'esales', tables: [], views: [], functions: [] },
        { name: 'eastmoney', tables: [], views: [], functions: [] },
      ],
    })
    // 与 SchemaBrowser 同一 key(conn.id 即 SqlConsole 的 profileId)隐藏 esales。
    writeHiddenSchemas('prof-1', ['esales'])

    wrap(<SqlConsole connId="c1" profileId="prof-1" engine="postgres" fresh />)

    const select = await screen.findByTestId('sql-default-schema')
    await waitFor(() => {
      const values = within(select as HTMLElement).getAllByRole('option').map(o => (o as HTMLOptionElement).value)
      expect(values).toContain('public')
      expect(values).toContain('eastmoney')
      expect(values).not.toContain('esales')
    })
  })
})
