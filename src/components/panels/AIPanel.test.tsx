import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import type { AgentConfig } from '../../state/agentConfig'
import type { Conversation } from '../../state/conversations'
import type { Connection } from '../../services/types'

// Active host tab — the panel follows it. Without a conn the panel shows the
// connect-first empty state (covered by its own test below).
const hostConn: Connection = { id: 'h1', group: '', kind: 'host', name: 'prod-web-01', sub: 'x', icon: 'server', status: 'up', proto: 'ssh' }

// ---- Mocks ----

const baseConfig = (): AgentConfig => ({
  provider: 'ollama', baseUrl: 'http://h', apiKey: '', anthropicAuthMode: 'api-key',
  model: 'm', executionMode: 'manual', singleLineCommands: true, maxShellSteps: 8,
})
let mockConfig: AgentConfig = baseConfig()
const mockUpdate = vi.fn()
vi.mock('../../state/agentConfig', () => ({
  useAgentConfig: () => ({ config: mockConfig, update: mockUpdate }),
}))

// db service — drives the "@ 选表" dropdown (getSchema) and DDL context (tableStructure).
vi.mock('../../services/db', () => ({
  getSchema: vi.fn(async () => ({
    db: 'd1',
    schemas: [{ name: 'public', open: false, tables: [{ name: 'orders', rows: '', cols: 0 }], views: [], functions: [] }],
  })),
  tableStructure: vi.fn(async () => ({
    comment: '',
    columns: [{ name: 'id', type: 'bigint', nullable: false, default: null, key: 'PK', extra: '', comment: '' }],
    indexes: [],
    fks: [],
  })),
}))

import { AIPanel } from './AIPanel'
import { getSchema, tableStructure } from '../../services/db'

// A connected DB tab — required for the SQL-mode @ feature.
const dbConn: Connection = { id: 'd1', group: '', kind: 'db', name: 'prod-orders', sub: 'pg', icon: 'database', status: 'up', engine: 'postgres' }

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

function conv(messages: Conversation['messages'], id = 'c1'): Conversation {
  return { id, hostKey: 'h', title: '', messages, createdAt: 1, updatedAt: 1 }
}

beforeEach(() => {
  mockConfig = baseConfig()
  mockUpdate.mockReset()
})

describe('AIPanel controlled conversation view', () => {
  it.each([
    ['shell', hostConn],
    ['sql', dbConn],
  ] as const)('supports copying and asking a user question again in %s mode', (mode, conn) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onSend = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode={mode} conn={conn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'user', content: '检查当前连接状态' }])} onSend={onSend} />)

    fireEvent.click(screen.getByRole('button', { name: '复制问题' }))
    expect(writeText).toHaveBeenCalledWith('检查当前连接状态')

    fireEvent.click(screen.getByRole('button', { name: '重问' }))
    expect(onSend).toHaveBeenCalledWith('检查当前连接状态', { hasSelection: false })
  })

  it('renders the conversation messages as markdown', () => {
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '# Title\n\nhello **world**' }])} />)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
    expect(screen.getByText('world')).toBeTruthy() // inside <strong>
  })

  it('separates completed reasoning from the answer and lets the user expand it', () => {
    const { container } = wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '<think>check the service logs</think>\n\n## Result\n\nRunning' }])} />)
    const details = screen.getByText('思考过程').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(screen.getByRole('heading', { name: 'Result' })).toBeTruthy()
    expect(container.textContent).not.toContain('<think>')
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
    expect(screen.getByText('check the service logs')).toBeTruthy()
  })

  it('shows streaming reasoning in a fixed block and collapses it when the answer starts', () => {
    const panel = (content: string, busy: boolean) => (
      <LanguageProvider>
        <AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
          conversation={conv([{ role: 'assistant', content }])} busy={busy} />
      </LanguageProvider>
    )
    const { rerender } = render(panel('<think>checking **status**', true))
    let details = screen.getByText('思考中…').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(true)
    expect(screen.getByText('status')).toBeTruthy()
    const scrollArea = details.lastElementChild as HTMLDivElement
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 240 })
    rerender(panel('<think>checking **status**\n\nmore output', true))
    expect(scrollArea.scrollTop).toBe(240)

    fireEvent.wheel(scrollArea, { deltaY: -20 })
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 480 })
    scrollArea.scrollTop = 80
    rerender(panel('<think>checking **status**\n\nmore output\n\nfinal thought', true))
    expect(scrollArea.scrollTop).toBe(80)

    rerender(panel('<think>checking **status**</think>\n\nService is healthy', false))
    details = screen.getByText('思考过程').closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(screen.getByText('Service is healthy')).toBeTruthy()
  })

  it('typing and sending calls onSend with the draft text', () => {
    const onSend = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} onSend={onSend} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTitle('发送'))
    // 发送时附带 hasSelection 标记(无选中文本附件时为 false)
    expect(onSend).toHaveBeenCalledWith('hi', { hasSelection: false })
  })

  it('explains every execution mode and supports keyboard selection', () => {
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} />)
    const modeButton = screen.getByRole('button', { name: 'Agent 执行模式' })
    expect(modeButton.compareDocumentPosition(screen.getByTitle('选择模型')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    fireEvent.click(modeButton)
    let menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(modeButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByTitle('附加上下文')).toBeNull()
    expect(screen.getByText('仅生成命令和解读，不自动执行')).toBeTruthy()
    expect(screen.getByText(/仅删除、移动/)).toBeTruthy()
    expect(screen.getByText(/根据每轮结果/)).toBeTruthy()
    const modelLabel = screen.getByTitle('m')
    expect(modelLabel.style.maxWidth).toBe('')
    expect(modelLabel.style.flex).toBe('1 1 0%')
    expect(screen.getByRole('menuitemradio', { name: /手动/ })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitemradio', { name: /半自动/ })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(screen.getByRole('menuitemradio', { name: /全自动/ })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(screen.getByRole('menuitemradio', { name: /手动/ })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(mockUpdate).toHaveBeenCalledWith({ executionMode: 'ask' })
    expect(modeButton).toHaveFocus()

    fireEvent.click(modeButton)
    menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: ' ' })
    expect(mockUpdate).toHaveBeenCalledWith({ executionMode: 'auto' })

    fireEvent.click(modeButton)
    menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(modeButton).toHaveAttribute('aria-expanded', 'false')
    expect(modeButton).toHaveFocus()
  })

  it('renders a shell code block with an insert-into-terminal button that calls onInsert', () => {
    const onInsert = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: 'Run this:\n```sh\necho hi\n```' }])}
      onInsert={onInsert} canInsert />)
    fireEvent.click(screen.getByTitle('插入终端'))
    expect(onInsert).toHaveBeenCalledWith('echo hi')
  })

  it('clicking the new-conversation icon calls onNewConversation', () => {
    const onNewConversation = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} onNewConversation={onNewConversation} />)
    fireEvent.click(screen.getByTitle('新建对话'))
    expect(onNewConversation).toHaveBeenCalled()
  })

  it('history dropdown lists provided conversations and restoring calls onRestoreConversation', () => {
    const onRestore = vi.fn()
    const history: Conversation[] = [
      { id: 'past-1', hostKey: 'h', title: 'check disk usage', messages: [], createdAt: 1, updatedAt: Date.now() },
    ]
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} history={history} onRestoreConversation={onRestore} />)
    // open the history dropdown
    fireEvent.click(screen.getByTitle('会话历史'))
    const item = screen.getByText('check disk usage')
    expect(item).toBeTruthy()
    fireEvent.click(item)
    expect(onRestore).toHaveBeenCalledWith('past-1')
  })

  it('deleting a history item calls onDeleteConversation', () => {
    const onDelete = vi.fn()
    const history: Conversation[] = [
      { id: 'past-1', hostKey: 'h', title: 'old chat', messages: [], createdAt: 1, updatedAt: Date.now() },
    ]
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} history={history} onDeleteConversation={onDelete} />)
    fireEvent.click(screen.getByTitle('会话历史'))
    fireEvent.click(screen.getByTitle('删除会话'))
    expect(onDelete).toHaveBeenCalledWith('past-1')
  })

  it('shows empty-history hint when there are no past conversations', () => {
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} history={[]} />)
    fireEvent.click(screen.getByTitle('会话历史'))
    expect(screen.getByText('暂无历史会话')).toBeTruthy()
  })

  it('with no active host/db tab shows the connect-first empty state and hides the composer', () => {
    wrap(<AIPanel onClose={() => {}} mode="sql" attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} />)
    expect(screen.getByText('请先连接主机或数据库')).toBeTruthy()
    // composer + actions are hidden
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByTitle('新建对话')).toBeNull()
  })

  it('SQL 模式输入 @ 弹出表名下拉(来自 getSchema)', async () => {
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}} conversation={conv([])} onSend={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@' } })
    expect(await screen.findByText('orders')).toBeTruthy()
    expect(getSchema).toHaveBeenCalledWith('d1')
  })

  it('选中表加入 chip 并清除 @token', async () => {
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}} conversation={conv([])} onSend={() => {}} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'explain @or' } })
    fireEvent.click(await screen.findByText('orders'))
    // token removed from the draft, leaving the leading text
    expect(ta.value).toBe('explain ')
    // a removable chip now represents the picked table
    expect(screen.getByTitle('移除表')).toBeTruthy()
  })

  it('发送时对所选表调用 tableStructure 并把 DDL 上下文追加到消息,发送后清空 chip', async () => {
    const onSend = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}} conversation={conv([])} onSend={onSend} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'explain @' } })
    fireEvent.click(await screen.findByText('orders'))
    fireEvent.click(screen.getByTitle('发送'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(tableStructure).toHaveBeenCalledWith('d1', 'public', 'orders')
    const sent = onSend.mock.calls[0][0] as string
    expect(sent).toContain('explain')
    expect(sent).toContain('CREATE TABLE')
    // one-time context: chip cleared after send
    expect(screen.queryByTitle('移除表')).toBeNull()
  })

  it('shell 模式输入 @ 不弹表名下拉', () => {
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}} conversation={conv([])} onSend={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@' } })
    expect(screen.queryByText('orders')).toBeNull()
  })

  it('运行只读 SQL → 直接派发 catio-run,不弹确认框', () => {
    const onRun = vi.fn()
    window.addEventListener('catio-run', onRun)
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '```sql\nSELECT * FROM orders\n```' }])} />)
    fireEvent.click(screen.getByTitle('执行'))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect((onRun.mock.calls[0][0] as CustomEvent).detail.text).toBe('SELECT * FROM orders')
    window.removeEventListener('catio-run', onRun)
  })

  it('运行危险 SQL(DELETE)→ 先弹确认框,确认后才派发 catio-run', () => {
    const onRun = vi.fn()
    window.addEventListener('catio-run', onRun)
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '```sql\nDELETE FROM orders WHERE id = 1\n```' }])} />)
    fireEvent.click(screen.getByTitle('执行'))
    // 未确认前不派发
    expect(onRun).not.toHaveBeenCalled()
    expect(screen.getByText('确认执行 SQL')).toBeTruthy()
    fireEvent.click(screen.getByText('确认执行'))
    expect(onRun).toHaveBeenCalledTimes(1)
    window.removeEventListener('catio-run', onRun)
  })

  it('运行危险 SQL 后取消 → 不派发 catio-run', () => {
    const onRun = vi.fn()
    window.addEventListener('catio-run', onRun)
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '```sql\nDELETE FROM orders WHERE id = 1\n```' }])} />)
    fireEvent.click(screen.getByTitle('执行'))
    fireEvent.click(screen.getByText('取消'))
    expect(onRun).not.toHaveBeenCalled()
    window.removeEventListener('catio-run', onRun)
  })

  it('运行被阻断的 SQL(DROP)→ 不派发 catio-run,展示阻断提示', () => {
    const onRun = vi.fn()
    window.addEventListener('catio-run', onRun)
    wrap(<AIPanel onClose={() => {}} mode="sql" conn={dbConn} connId="d1" engine="postgres"
      attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '```sql\nDROP TABLE orders\n```' }])} />)
    fireEvent.click(screen.getByTitle('执行'))
    expect(onRun).not.toHaveBeenCalled()
    expect(screen.getByText(/已阻断/)).toBeTruthy()
    // 阻断弹窗没有「确认执行」按钮,只有关闭/知道了
    expect(screen.queryByText('确认执行')).toBeNull()
    window.removeEventListener('catio-run', onRun)
  })

  it('shell 模式运行命令 → 直接派发 catio-run(不经 SQL 分级)', () => {
    const onRun = vi.fn()
    window.addEventListener('catio-run', onRun)
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn}
      attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '```sh\nrm -rf /tmp/x\n```' }])} />)
    fireEvent.click(screen.getByTitle('运行'))
    expect(onRun).toHaveBeenCalledTimes(1)
    window.removeEventListener('catio-run', onRun)
  })

  it('shows the no-model hint and wires the configure button', () => {
    mockConfig = { ...baseConfig(), model: '' }
    const onOpenSettings = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} onOpenSettings={onOpenSettings} />)
    expect(screen.getByText(/未配置模型/)).toBeTruthy()
    fireEvent.click(screen.getByText('去配置模型'))
    expect(onOpenSettings).toHaveBeenCalled()
  })
})
