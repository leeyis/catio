import { render, screen, fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataProvider } from '../src/state/DataContext'
import App from '../src/App'

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
  // submit — "保存并连接" lives in the modal footer
  fireEvent.click(screen.getByText('保存并连接'))
  // a terminal tab should now exist; the default host name field is "prod-web-01".
  // It appears as the workbench tab title (and possibly elsewhere) — assert presence.
  expect(screen.getAllByText(/prod-web-01/).length).toBeGreaterThan(0)
})
