import { render, screen, fireEvent } from '@testing-library/react'
import { vi, beforeEach } from 'vitest'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataProvider } from '../src/state/DataContext'
import { saveProfile } from '../src/state/connections'
import App from '../src/App'

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
