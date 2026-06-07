import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { TerminalPane, DbWorkbench } from '../src/components/workbench'
import { DATA } from '../src/services/mockData'

// xterm.js can't render in jsdom (no matchMedia/layout) — mock the surface.
// The terminal CONTENT is now an xterm canvas, so we assert the surrounding
// chrome (header/host name) renders instead of buffer text.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24
    open() {} write() {} onData() {} onSelectionChange() {}
    clearSelection() {} clear() {} getSelection() { return '' }
    loadAddon() {} dispose() {} focus() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} activate() {} dispose() {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('TerminalPane renders terminal chrome (xterm surface)', () => {
  wrap(<TerminalPane conn={DATA.byId['h-bastion']} />)
  // header shows the connection name + connected chip (chrome preserved)
  expect(screen.getAllByText(/db-bastion/i).length).toBeGreaterThan(0)
  expect(screen.getByText(/connected/i)).toBeTruthy()
})
it('DbWorkbench renders schema table name orders', () => {
  wrap(<DbWorkbench conn={DATA.byId['d-orders']} />)
  expect(screen.getAllByText(/orders/i).length).toBeGreaterThan(0)
})
