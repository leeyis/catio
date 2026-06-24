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

let mockConfig: AgentConfig = { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' }
vi.mock('../../state/agentConfig', () => ({
  useAgentConfig: () => ({ config: mockConfig, update: () => {} }),
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
  mockConfig = { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' }
})

describe('AIPanel controlled conversation view', () => {
  it('renders the conversation messages as markdown', () => {
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([{ role: 'assistant', content: '# Title\n\nhello **world**' }])} />)
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
    expect(screen.getByText('world')).toBeTruthy() // inside <strong>
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
    mockConfig = { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: '' }
    const onOpenSettings = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" conn={hostConn} attachment={null} onClearAttachment={() => {}}
      conversation={conv([])} onOpenSettings={onOpenSettings} />)
    expect(screen.getByText(/未配置模型/)).toBeTruthy()
    fireEvent.click(screen.getByText('去配置模型'))
    expect(onOpenSettings).toHaveBeenCalled()
  })
})
