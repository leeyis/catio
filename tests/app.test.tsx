import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, beforeEach } from 'vitest'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataProvider } from '../src/state/DataContext'
import { saveProfile } from '../src/state/connections'
import App from '../src/App'

// Mock the agent so chat() streams deterministic tokens through onToken.
const agentMock = vi.hoisted(() => ({ chat: vi.fn() }))
vi.mock('../src/services/agent', () => ({ chat: agentMock.chat }))

beforeEach(() => localStorage.clear())

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
  // Fresh: no profiles → empty private-workspace state in the sidebar.
  const fresh = wrap()
  expect(screen.getByText('这是你的私有工作区')).toBeTruthy()
  fresh.unmount()

  // With a saved profile in localStorage, the vault renders it.
  saveProfile({ id: 'live-1.2.3.4:22-deploy', name: 'my-server', host: '1.2.3.4', port: 22, user: 'deploy', auth: { method: 'password' } })
  wrap()
  expect(screen.getAllByText('my-server').length).toBeGreaterThan(0)
})

it('clicking a vault card opens the connection details (not a terminal tab)', () => {
  saveProfile({ id: 'live-1.2.3.4:22-deploy', name: 'my-server', host: '1.2.3.4', port: 22, user: 'deploy', auth: { method: 'password' } })
  wrap()
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
// conversation title). Previously patchConversation relied on the setState
// updater's return value, which React 18 doesn't run synchronously under
// streaming bursts, so assistant tokens never reached localStorage.
it('persists the full streamed assistant reply, not just the conversation title', async () => {
  // a model must be configured for the composer to allow sending
  localStorage.setItem('catio-agent-config', JSON.stringify({
    provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434',
    openaiBaseUrl: 'https://api.openai.com', openaiKey: '', model: 'llama3',
  }))
  agentMock.chat.mockImplementation(async (_msgs: unknown, _cfg: unknown, opts: { onToken: (t: string) => void }) => {
    opts.onToken('Hello')
    opts.onToken(', ')
    opts.onToken('world!')
  })

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
