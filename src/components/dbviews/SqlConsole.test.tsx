import { describe, it, expect, vi, beforeAll } from 'vitest'
import { forwardRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { SqlConsole } from './SqlConsole'

// CodeMirror 在 jsdom 下难以稳定挂载,且本测试只关心 SqlConsole 自身的分屏/最大化布局,
// 故把 SqlEditor 替换成一个轻量桩件。
vi.mock('./SqlEditor', () => ({
  SqlEditor: forwardRef<unknown, unknown>(() => <div data-testid="sql-editor-stub" />),
}))

// db 服务在非 connId(mock)路径下不会被调用,但 import 时仍需存在。
vi.mock('../../services/db', () => ({
  runQuery: vi.fn(),
  getSchema: vi.fn(() => Promise.resolve({ schemas: [] })),
  schemaColumns: vi.fn(() => Promise.resolve([])),
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
