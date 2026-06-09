import { render, screen, fireEvent } from '@testing-library/react'
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

import { AIPanel } from './AIPanel'

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
    expect(onSend).toHaveBeenCalledWith('hi')
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
