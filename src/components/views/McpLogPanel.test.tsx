import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { McpLogPanel } from './SettingsView'
import { mergeMcpLogReplay } from '../../services/mcp'
import type { McpLogEntry } from '../../services/mcp'

/// 受测面板由 `subscribe` 驱动。这个假订阅把 emit 函数交回给测试，从而可以精确控制
/// 推给面板的条目，无需真实后端。
function harness() {
  let emit!: (e: McpLogEntry) => void
  const subscribe = (cb: (e: McpLogEntry) => void) => {
    emit = cb
    return Promise.resolve(() => {})
  }
  return { subscribe, push: (e: McpLogEntry) => act(() => emit(e)) }
}

const entry = (over: Partial<McpLogEntry> = {}): McpLogEntry => ({
  ts: '2026-08-18T10:11:12Z',
  kind: 'tools/result',
  ip: '127.0.0.1',
  ...over,
})

// i18n 在测试环境下按 fallbackLng='zh' 真实翻译，故用中文文案定位按钮。
const fullscreenBtn = () => screen.getByRole('button', { name: '全屏' })
const restoreBtn = () => screen.getByRole('button', { name: '还原' })

describe('McpLogPanel', () => {
  it('merges file replay with events buffered during listener startup', () => {
    const call = entry({ ts: '2026-08-29T10:00:00Z', kind: 'tools/call', tool: 'execute_command', args: { command: 'pwd' } })
    const result = entry({ ts: '2026-08-29T10:00:01Z', kind: 'tools/result', tool: 'execute_command', output: '/workspace' })
    const next = entry({ ts: '2026-08-29T10:00:02Z', kind: 'tools/call', tool: 'list_files' })

    expect(mergeMcpLogReplay([call, result], [result, next])).toEqual([call, result, next])
  })

  it('keeps buffered events when the replay has no overlap', () => {
    const prior = entry({ ts: '2026-08-29T10:00:00Z', kind: 'tools/list' })
    const live = entry({ ts: '2026-08-29T10:00:01Z', kind: 'tools/call', tool: 'execute_command' })

    expect(mergeMcpLogReplay([prior], [live])).toEqual([prior, live])
  })

  it('renders tool output with ANSI colors applied and escapes stripped', async () => {
    const h = harness()
    render(<McpLogPanel subscribe={h.subscribe} />)
    // 绿色 ✓ + 红色 FAILED，外加一个不可渲染的清行序列。
    h.push(entry({ tool: 'execute_command', output: '\x1b[32mPASS\x1b[0m and \x1b[31mFAILED\x1b[0m\x1b[K' }))

    const pass = await screen.findByText('PASS')
    expect(pass.className).toBe('ansi-green')
    expect(screen.getByText('FAILED').className).toBe('ansi-red')
    // 关键：控制字符不得进入 DOM（否则显示为乱码）。
    expect(document.body.textContent).not.toContain('\x1b')
    expect(document.body.textContent).toContain('and')
  })

  it('toggles fullscreen and back', async () => {
    const h = harness()
    const { container } = render(<McpLogPanel subscribe={h.subscribe} />)
    const shell = container.firstElementChild as HTMLElement

    // 初始为内联，不是浮层。
    expect(shell.style.position).not.toBe('fixed')

    act(() => { fullscreenBtn().click() })
    await waitFor(() => expect(shell.style.position).toBe('fixed'))
    expect(shell.style.zIndex).toBe('60')
    // 从标题栏下沿开始，而不是 inset:0——否则会盖住主题/设置/窗口控件。
    expect(shell.style.top).toBe('48px')
    expect(shell.style.bottom).toBe('0px')
    expect(shell.style.background).toBe('var(--bg-canvas)')

    // 还原按钮把它变回内联。
    act(() => { restoreBtn().click() })
    await waitFor(() => expect(shell.style.position).not.toBe('fixed'))
  })

  it('leaves fullscreen when Escape is pressed', async () => {
    const h = harness()
    const { container } = render(<McpLogPanel subscribe={h.subscribe} />)
    const shell = container.firstElementChild as HTMLElement

    act(() => { fullscreenBtn().click() })
    await waitFor(() => expect(shell.style.position).toBe('fixed'))

    // 浮层遮住了设置页，键盘出口是必要的。
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    await waitFor(() => expect(shell.style.position).not.toBe('fixed'))
  })

  it('keeps the newest entries when the ring buffer overflows', async () => {
    const h = harness()
    render(<McpLogPanel subscribe={h.subscribe} />)
    // 推 205 条（环容量 200），最早的必须被挤掉、最新的必须在。
    for (let i = 0; i < 205; i++) h.push(entry({ tool: `tool-${i}` }))
    await waitFor(() => expect(screen.queryByText('tool-204')).toBeTruthy())
    expect(screen.queryByText('tool-0')).toBeNull()
    expect(screen.queryByText('tool-4')).toBeNull()
    expect(screen.queryByText('tool-5')).toBeTruthy()
  })

  it('renders an error output without crashing on ANSI parsing', async () => {
    const h = harness()
    render(<McpLogPanel subscribe={h.subscribe} />)
    h.push(entry({ tool: 'execute_command', isError: true, output: 'command timed out after 30000ms' }))
    expect(await screen.findByText(/command timed out/)).toBeTruthy()
  })
})
