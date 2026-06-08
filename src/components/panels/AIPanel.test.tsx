import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import type { AgentConfig } from '../../state/agentConfig'
import type { ChatMsg, ChatOptions } from '../../services/agent'

// ---- Mocks ----

const chatMock = vi.fn()
vi.mock('../../services/agent', () => ({
  chat: (messages: ChatMsg[], cfg: AgentConfig, opts?: ChatOptions) => chatMock(messages, cfg, opts),
}))

let mockConfig: AgentConfig = { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' }
vi.mock('../../state/agentConfig', () => ({
  useAgentConfig: () => ({ config: mockConfig, update: () => {} }),
}))

import { AIPanel } from './AIPanel'

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

beforeEach(() => {
  chatMock.mockReset()
  mockConfig = { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: 'm' }
})

describe('AIPanel real streaming chat', () => {
  it('streams markdown and renders headings + bold correctly', async () => {
    chatMock.mockImplementation(async (_m: ChatMsg[], _c: AgentConfig, opts?: ChatOptions) => {
      opts?.onToken?.('# Title\n\nhello **world**')
      return '# Title\n\nhello **world**'
    })
    wrap(<AIPanel onClose={() => {}} mode="shell" attachment={null} onClearAttachment={() => {}} />)
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.click(screen.getByTitle('发送'))
    // ReactMarkdown renders "# Title" as an <h1> and "**world**" as <strong>
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
      expect(screen.getByText('world')).toBeTruthy()  // inside <strong>
    })
  })

  it('renders a shell code block with an insert-into-terminal button', async () => {
    chatMock.mockImplementation(async (_m: ChatMsg[], _c: AgentConfig, opts?: ChatOptions) => {
      const reply = 'Run this:\n```sh\necho hi\n```'
      opts?.onToken?.(reply)
      return reply
    })
    const onInsert = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" attachment={null} onClearAttachment={() => {}} onInsert={onInsert} canInsert />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'how' } })
    fireEvent.click(screen.getByTitle('发送'))
    const btn = await screen.findByTitle('插入终端')
    fireEvent.click(btn)
    expect(onInsert).toHaveBeenCalledWith('echo hi')
  })

  it('shows the no-model hint and wires the configure button', () => {
    mockConfig = { provider: 'ollama', ollamaBaseUrl: 'http://h', openaiBaseUrl: '', openaiKey: '', model: '' }
    const onOpenSettings = vi.fn()
    wrap(<AIPanel onClose={() => {}} mode="shell" attachment={null} onClearAttachment={() => {}} onOpenSettings={onOpenSettings} />)
    expect(screen.getByText(/未配置模型/)).toBeTruthy()
    fireEvent.click(screen.getByText('去配置模型'))
    expect(onOpenSettings).toHaveBeenCalled()
  })
})
