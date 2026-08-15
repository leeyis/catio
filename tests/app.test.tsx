import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { vi, beforeEach } from 'vitest'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataProvider } from '../src/state/DataContext'
import { saveProfile } from '../src/state/connections'
import App from '../src/App'

// Mock the Rust AgentRuntime transport: subscribe captures the event handler,
// start returns a fixed turn id, respond/cancel record calls. The real
// `isAgentEventEnvelope` guard + projector + App effect runner run against
// scripted envelopes.
const agentRuntimeMock = vi.hoisted(() => {
  return {
    subscribeAgentEvents: vi.fn(),
    startAgentTurn: vi.fn(),
    respondToAgentTurn: vi.fn(),
    cancelAgentTurn: vi.fn(),
  }
})
vi.mock('../src/services/agentRuntime', async () => {
  const actual = await vi.importActual<typeof import('../src/services/agentRuntime')>('../src/services/agentRuntime')
  return {
    ...actual,
    subscribeAgentEvents: agentRuntimeMock.subscribeAgentEvents,
    startAgentTurn: agentRuntimeMock.startAgentTurn,
    respondToAgentTurn: agentRuntimeMock.respondToAgentTurn,
    cancelAgentTurn: agentRuntimeMock.cancelAgentTurn,
  }
})
// PTY capture adapter: no real terminal in jsdom. The busy check stays false so
// executeAgentCommand never asks for a split.
vi.mock('../src/services/terminalCapture', () => ({
  isTerminalChannelBusy: () => false,
  runTerminalCommandAndCapture: vi.fn(async () => ({ status: 'completed', exitCode: 0, output: '/tmp' })),
  buildTerminalResultPrompt: () => '',
}))

// Records whether subscribe completed before start (the required ordering).
const agentOrder: string[] = []
let agentEventHandler: ((payload: unknown) => void) | null = null

beforeEach(() => {
  localStorage.clear()
  agentRuntimeMock.subscribeAgentEvents.mockReset()
  agentRuntimeMock.startAgentTurn.mockReset()
  agentRuntimeMock.respondToAgentTurn.mockReset()
  agentRuntimeMock.cancelAgentTurn.mockReset()
  agentOrder.length = 0
  agentEventHandler = null
  agentRuntimeMock.subscribeAgentEvents.mockImplementation(async handler => {
    agentOrder.push('subscribe')
    agentEventHandler = handler
    return () => { agentEventHandler = null }
  })
  agentRuntimeMock.startAgentTurn.mockImplementation(async () => {
    agentOrder.push('start')
    return { turnId: 'turn-1' }
  })
  agentRuntimeMock.respondToAgentTurn.mockResolvedValue(undefined)
  agentRuntimeMock.cancelAgentTurn.mockResolvedValue(undefined)
})

// The conversation id is generated at send time; read it from the persisted
// store (the user message is written synchronously before startAgentTurn).
function currentConversationId(): string {
  const raw = localStorage.getItem('catio-conversations') ?? '[]'
  const convs = JSON.parse(raw) as Array<{ id: string }>
  return convs[0].id
}

function emitAgent(sequence: number, event: unknown): void {
  agentEventHandler?.({
    ownerId: 'local',
    conversationId: currentConversationId(),
    turnId: 'turn-1',
    sequence,
    event,
  })
}

// Mock xterm so the real library doesn't run in jsdom (avoids HTMLCanvasElement.getContext errors).
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    open() {}
    write() {}
    onData() {}
    onSelectionChange() {}
    clearSelection() {}
    clear() {}
    getSelection() { return '' }
    loadAddon() {}
    dispose() {}
    focus() {}
    onResize() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} activate() {} dispose() {} },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { onContextLoss() {} dispose() {} },
}))
// xterm.css import — stub so the bundler/test doesn't choke
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const wrap = () => render(<LanguageProvider><DataProvider><App /></DataProvider></LanguageProvider>)

it('renders home view by default with hero', () => {
  wrap()
  // stable zh string from HomeView hero (home.heroTitle)
  expect(screen.getAllByText(/服务器与数据库/).length).toBeGreaterThan(0)
})

it('boots clean: no demo tabs and Agent panel collapsed', () => {
  wrap()
  // No demo tab titles should be present (workbench shows nothing; we're on home).
  expect(screen.queryByText(/prod-orders · orders/)).toBeNull()
  // Agent panel is collapsed on boot → its composer placeholder is not rendered.
  expect(screen.queryByText('SQL 模式')).toBeNull()
})

it('vault is empty on a fresh install, and renders a saved profile', () => {
  // Fresh: no profiles → empty-state in the sidebar.
  const fresh = wrap()
  fireEvent.click(screen.getByRole('button', { name: '主机' }))
  expect(screen.getByText('还没有连接')).toBeTruthy()
  fresh.unmount()

  // With a saved profile in localStorage, the vault renders it.
  saveProfile({ id: 'live-1.2.3.4:22-deploy', name: 'my-server', host: '1.2.3.4', port: 22, user: 'deploy', auth: { method: 'password' } })
  wrap()
  fireEvent.click(screen.getByRole('button', { name: '主机' }))
  expect(screen.getAllByText('my-server').length).toBeGreaterThan(0)
})

it('clicking a vault card opens the connection details (not a terminal tab)', () => {
  saveProfile({ id: 'live-1.2.3.4:22-deploy', name: 'my-server', host: '1.2.3.4', port: 22, user: 'deploy', auth: { method: 'password' } })
  wrap()
  fireEvent.click(screen.getByRole('button', { name: '主机' }))
  // Click the saved card in the sidebar (first occurrence of the name).
  fireEvent.click(screen.getAllByText('my-server')[0])
  // Details panel header should appear (panels.detailsTitle zh).
  expect(screen.getByText('连接详情')).toBeTruthy()
  // The DetailsPanel Connect button is present; no terminal tab was opened.
  expect(screen.getByText('连接')).toBeTruthy()
})

it('clicking 新建连接 opens the New Connection modal', () => {
  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  // modal subtitle is a stable, unique zh string
  expect(screen.getByText('主机与数据库统一管理 · 凭据加密存储')).toBeTruthy()
})

it('theme toggle changes data-theme attribute', () => {
  wrap()
  const before = document.documentElement.getAttribute('data-theme')
  // find the theme toggle button by its title (shell.toggleTheme zh '切换主题')
  const btn = screen.getByTitle('切换主题')
  fireEvent.click(btn)
  const after = document.documentElement.getAttribute('data-theme')
  expect(after).not.toBe(before)
})

// ORCH: in jsdom (no Tauri) the modal's "Save & connect" for a HOST opens a
// demo terminal tab via the onConnect→connectProfile demo path (no IPC, no crash).
it('new host connection opens a demo terminal tab without Tauri', () => {
  wrap()
  // open the New Connection modal (home view has a "新建连接" CTA)
  fireEvent.click(screen.getAllByText('新建连接')[0])
  // switch to the host/terminal kind so the SSH connect path is active
  fireEvent.click(screen.getByText('主机 / 终端'))
  // create defaults are empty now — fill in the host (the name falls back to it).
  // "主机" appears as both a tab and a field label; pick the label with an input.
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(p => p?.querySelector('input')) as HTMLElement
  const host = hostLabel.querySelector('input') as HTMLInputElement
  fireEvent.input(host, { target: { value: 'edge-01' } })
  // submit — "保存并连接" lives in the modal footer
  fireEvent.click(screen.getByText('保存并连接'))
  // a terminal tab should now exist, titled by the host we typed.
  expect(screen.getAllByText(/edge-01/).length).toBeGreaterThan(0)
})

it('does not add empty Agent conversations when opening tabs or starting over', () => {
  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(p => p?.querySelector('input')) as HTMLElement
  fireEvent.input(hostLabel.querySelector('input') as HTMLInputElement, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))

  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))
  fireEvent.click(screen.getByTitle('新建对话'))
  fireEvent.click(screen.getByTitle('新建对话'))
  fireEvent.click(screen.getByTitle('会话历史'))

  expect(screen.getByText('暂无历史会话')).toBeTruthy()
  expect(JSON.parse(localStorage.getItem('catio-conversations') ?? '[]')).toEqual([])
})

// PERSISTENCE: the workbench body (incl. the terminal pane) stays MOUNTED when
// switching to Settings and back — the body is no longer torn down on view change,
// so the live PTY + xterm buffer survive. We assert the pane container persists by
// checking the tab/pane DOM nodes remain present across the view switch.
it('persists the terminal pane across a view switch (settings overlay, body stays mounted)', () => {
  wrap()
  // open a demo terminal tab (no Tauri → demo path, no IPC)
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(p => p?.querySelector('input')) as HTMLElement
  const host = hostLabel.querySelector('input') as HTMLInputElement
  fireEvent.input(host, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))
  // tab + pane are present in workbench
  const beforeCount = screen.getAllByText(/edge-01/).length
  expect(beforeCount).toBeGreaterThan(0)

  // switch to Settings (overlay on top — must NOT unmount the body/pane)
  fireEvent.click(screen.getByTitle('设置'))
  // Settings is showing (its title appears)…
  expect(screen.getAllByText('设置').length).toBeGreaterThan(0)
  // …and the terminal pane/tab is STILL in the DOM underneath the overlay.
  expect(screen.getAllByText(/edge-01/).length).toBeGreaterThan(0)

  // switch back to the workbench — same tab/pane is still there (never remounted)
  fireEvent.click(screen.getByTitle('设置'))
  expect(screen.getAllByText(/edge-01/).length).toBeGreaterThan(0)
})

// REGRESSION: a streamed agent reply must be PERSISTED in full (not just the
// conversation title). The Rust runtime streams ordered envelopes; the App
// projector appends text deltas to the trailing assistant message.
it('persists the full streamed assistant reply, not just the conversation title', async () => {
  // a model must be configured for the composer to allow sending
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
    anthropicAuthMode: 'api-key', model: 'llama3', executionMode: 'manual',
  }))

  wrap()
  // open a demo terminal tab so there's an active host context for the Agent
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(p => p?.querySelector('input')) as HTMLElement
  const host = hostLabel.querySelector('input') as HTMLInputElement
  fireEvent.input(host, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))

  // open the Agent panel via the icon rail
  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))

  // type a prompt + send
  const composer = screen.getByPlaceholderText(/生成 shell 命令/) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'list files' } })
  fireEvent.click(screen.getByTitle('发送'))

  // subscribe must resolve before startAgentTurn is issued.
  await waitFor(() => expect(agentOrder).toEqual(['subscribe', 'start']))

  // Script the ordered envelopes of a text-only turn.
  emitAgent(1, { type: 'turnStarted' })
  emitAgent(2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 })
  emitAgent(3, { type: 'textDelta', messageId: 'm0', delta: 'Hello' })
  emitAgent(4, { type: 'textDelta', messageId: 'm0', delta: ', ' })
  emitAgent(5, { type: 'textDelta', messageId: 'm0', delta: 'world!' })
  emitAgent(6, { type: 'assistantMessageFinished', messageId: 'm0' })
  emitAgent(7, { type: 'turnFinished' })

  // the conversation in localStorage must contain the FULL assistant reply
  await waitFor(() => {
    const raw = localStorage.getItem('catio-conversations') ?? '[]'
    const convs = JSON.parse(raw) as Array<{ messages: Array<{ role: string; content: string }> }>
    const assistant = convs.flatMap(c => c.messages).find(m => m.role === 'assistant')
    expect(assistant?.content).toBe('Hello, world!')
  })
  // and the user message is persisted too
  const raw = localStorage.getItem('catio-conversations') ?? '[]'
  expect(raw).toContain('list files')
})

it('shows Agent command permission target and command as separately labelled regions', async () => {
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
    anthropicAuthMode: 'api-key', model: 'llama3', executionMode: 'ask',
  }))
  const command = 'sudo systemctl start ollama.service'

  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(parent => parent?.querySelector('input')) as HTMLElement
  fireEvent.input(hostLabel.querySelector('input') as HTMLInputElement, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))
  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))
  fireEvent.change(screen.getByPlaceholderText(/生成 shell 命令/), { target: { value: 'start Ollama' } })
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(agentOrder).toEqual(['subscribe', 'start']))

  // Script a sensitive tool proposal + approval request.
  emitAgent(1, { type: 'turnStarted' })
  emitAgent(2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 })
  emitAgent(3, { type: 'toolProposed', toolUseId: 'tool-1', name: 'terminal_exec', input: { command }, risk: ['service'] })
  emitAgent(4, { type: 'approvalRequested', toolUseId: 'tool-1', reason: 'sensitiveCommand' })

  expect(await screen.findByText('允许 Agent 执行命令？')).toBeInTheDocument()
  const targetRegion = screen.getByRole('group', { name: /执行节点/ })
  const commandRegion = screen.getByRole('group', { name: /执行命令/ })
  expect(targetRegion).toHaveTextContent('edge-01')
  expect(targetRegion).not.toHaveTextContent(command)
  expect(within(commandRegion).getByText(command)).toHaveClass('mono')

  // Deny flows back to the engine as an approvalDecision.
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByText('允许 Agent 执行命令？')).toBeNull())
  await waitFor(() => {
    expect(agentRuntimeMock.respondToAgentTurn).toHaveBeenCalledWith('turn-1', {
      type: 'approvalDecision',
      toolUseId: 'tool-1',
      decision: 'deny',
    })
  })
})

it('executes each ToolExecutionRequested exactly once and replies with the outcome', async () => {
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
    anthropicAuthMode: 'api-key', model: 'llama3', executionMode: 'manual',
  }))
  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(parent => parent?.querySelector('input')) as HTMLElement
  fireEvent.input(hostLabel.querySelector('input') as HTMLInputElement, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))
  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))
  fireEvent.change(screen.getByPlaceholderText(/生成 shell 命令/), { target: { value: 'run pwd' } })
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(agentOrder).toEqual(['subscribe', 'start']))

  emitAgent(1, { type: 'turnStarted' })
  emitAgent(2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 })
  emitAgent(3, { type: 'toolProposed', toolUseId: 'tool-1', name: 'terminal_exec', input: { command: 'pwd' }, risk: [] })
  emitAgent(4, { type: 'toolExecutionRequested', toolUseId: 'tool-1', target: 'target-1', input: { command: 'pwd' } })

  await waitFor(() => {
    expect(agentRuntimeMock.respondToAgentTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({
      type: 'toolExecutionResult',
      toolUseId: 'tool-1',
      outcome: expect.objectContaining({ content: expect.stringContaining('exitCode') }),
    }))
  })
  expect(agentRuntimeMock.respondToAgentTurn).toHaveBeenCalledTimes(1)
})

it('abort cancels the backend turn and outcome-unknown shows a localized warning', async () => {
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
    anthropicAuthMode: 'api-key', model: 'llama3', executionMode: 'manual',
  }))
  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(parent => parent?.querySelector('input')) as HTMLElement
  fireEvent.input(hostLabel.querySelector('input') as HTMLInputElement, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))
  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))
  fireEvent.change(screen.getByPlaceholderText(/生成 shell 命令/), { target: { value: 'run pwd' } })
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(agentOrder).toEqual(['subscribe', 'start']))

  // Stop button → backend cancel.
  fireEvent.click(await screen.findByTitle('停止'))
  await waitFor(() => expect(agentRuntimeMock.cancelAgentTurn).toHaveBeenCalledWith('turn-1'))

  // A tool dispatch that arrives after abort must report outcomeUnknown, never "cancelled".
  emitAgent(1, { type: 'turnStarted' })
  emitAgent(2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 })
  emitAgent(3, { type: 'toolExecutionRequested', toolUseId: 'tool-1', target: 'target-1', input: { command: 'pwd' } })

  await waitFor(() => {
    expect(agentRuntimeMock.respondToAgentTurn).toHaveBeenCalledWith('turn-1', {
      type: 'toolExecutionResult',
      toolUseId: 'tool-1',
      outcome: { status: 'outcomeUnknown', content: 'aborted; outcome unknown' },
    })
  })
  await waitFor(() => expect(screen.getByText(/命令可能仍在目标终端运行/)).toBeInTheDocument())
})

interface RequestMessage { role: string; content: Array<{ type: string; text: string }> }

it('sends the current user message as the last request message (new + existing conversations)', async () => {
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
    anthropicAuthMode: 'api-key', model: 'llama3', executionMode: 'manual',
  }))
  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(parent => parent?.querySelector('input')) as HTMLElement
  fireEvent.input(hostLabel.querySelector('input') as HTMLInputElement, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))
  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))

  const composer = screen.getByPlaceholderText(/生成 shell 命令/) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'first message' } })
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(agentOrder).toEqual(['subscribe', 'start']))

  // New conversation: the outgoing request must carry the CURRENT user message
  // as its last message — never the empty assistant placeholder.
  const firstRequest = agentRuntimeMock.startAgentTurn.mock.calls[0][0] as { messages: RequestMessage[] }
  const firstMessages = firstRequest.messages
  expect(firstMessages[firstMessages.length - 1]).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'first message' }],
  })
  expect(firstMessages.some(m => m.role === 'assistant' && m.content.length === 0)).toBe(false)

  // Settle turn 1 so a second send is accepted.
  emitAgent(1, { type: 'turnStarted' })
  emitAgent(2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 })
  emitAgent(3, { type: 'textDelta', messageId: 'm0', delta: 'ok' })
  emitAgent(4, { type: 'assistantMessageFinished', messageId: 'm0' })
  emitAgent(5, { type: 'turnFinished' })
  await waitFor(() => expect(screen.queryByTitle('停止')).toBeNull())

  // Existing conversation: prior history + current user message, still no placeholder.
  fireEvent.change(composer, { target: { value: 'second message' } })
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(agentRuntimeMock.startAgentTurn).toHaveBeenCalledTimes(2))

  const secondRequest = agentRuntimeMock.startAgentTurn.mock.calls[1][0] as { messages: RequestMessage[] }
  const secondMessages = secondRequest.messages
  expect(secondMessages[secondMessages.length - 1]).toEqual({
    role: 'user',
    content: [{ type: 'text', text: 'second message' }],
  })
  expect(secondMessages.some(m => m.role === 'user' && m.content[0]?.text === 'first message')).toBe(true)
  expect(secondMessages.some(m => m.role === 'assistant' && m.content.length === 0)).toBe(false)
})

it('drops malformed envelopes before they touch the conversation', async () => {
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '',
    anthropicAuthMode: 'api-key', model: 'llama3', executionMode: 'manual',
  }))
  wrap()
  fireEvent.click(screen.getAllByText('新建连接')[0])
  fireEvent.click(screen.getByText('主机 / 终端'))
  const hostLabel = screen.getAllByText('主机').map(el => el.parentElement)
    .find(parent => parent?.querySelector('input')) as HTMLElement
  fireEvent.input(hostLabel.querySelector('input') as HTMLInputElement, { target: { value: 'edge-01' } })
  fireEvent.click(screen.getByText('保存并连接'))
  fireEvent.click(screen.getByTitle('Catio Agent · 跨终端与数据库'))
  fireEvent.change(screen.getByPlaceholderText(/生成 shell 命令/), { target: { value: 'list' } })
  fireEvent.click(screen.getByTitle('发送'))
  await waitFor(() => expect(agentOrder).toEqual(['subscribe', 'start']))

  const convId = currentConversationId()
  // Malformed: missing sequence, NaN sequence, unknown event type, missing field.
  agentEventHandler?.({ ownerId: 'local', conversationId: convId, turnId: 'turn-1', event: { type: 'turnStarted' } } as never)
  agentEventHandler?.({ ownerId: 'local', conversationId: convId, turnId: 'turn-1', sequence: NaN, event: { type: 'turnStarted' } } as never)
  agentEventHandler?.({ ownerId: 'local', conversationId: convId, turnId: 'turn-1', sequence: 1, event: { type: 'teleport' } } as never)
  agentEventHandler?.({ ownerId: 'local', conversationId: convId, turnId: 'turn-1', sequence: 2, event: { type: 'textDelta', messageId: 'm0' } } as never)

  // A valid turn still streams normally after the malformed payloads.
  emitAgent(1, { type: 'turnStarted' })
  emitAgent(2, { type: 'assistantMessageStarted', messageId: 'm0', round: 0 })
  emitAgent(3, { type: 'textDelta', messageId: 'm0', delta: 'ok' })
  emitAgent(4, { type: 'turnFinished' })
  await waitFor(() => expect(screen.queryByTitle('停止')).toBeNull())

  const raw = localStorage.getItem('catio-conversations') ?? '[]'
  const convs = JSON.parse(raw) as Array<{ messages: Array<{ role: string; content: string }> }>
  const assistant = convs.flatMap(c => c.messages).filter(m => m.role === 'assistant')
  // Exactly one assistant message, fed only by the valid deltas.
  expect(assistant).toHaveLength(1)
  expect(assistant[0].content).toBe('ok')
})
