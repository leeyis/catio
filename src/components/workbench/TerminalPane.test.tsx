import { render, waitFor, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DATA } from '../../services/mockData'

// ---- ssh service mock ----
const h = vi.hoisted(() => ({
  termOpen: vi.fn().mockResolvedValue('chan-1'),
  termWrite: vi.fn(),
  termResize: vi.fn(),
  termClose: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  getTermBuffer: vi.fn().mockResolvedValue([]),
  xtermWrite: vi.fn(),
  xtermPaste: vi.fn(),
  xtermDispose: vi.fn(),
  dataCb: { fn: null as ((d: string) => void) | null },
  keyHandler: { fn: null as ((ev: KeyboardEvent) => boolean) | null },
}))
const { termOpen, termWrite, termResize, termClose, listen, xtermWrite, xtermPaste, xtermDispose } = h

vi.mock('../../services/ssh', () => ({
  termOpen: h.termOpen,
  termWrite: h.termWrite,
  termResize: h.termResize,
  termClose: h.termClose,
  listen: h.listen,
  getTermBuffer: h.getTermBuffer,
}))

// ---- xterm mock (jsdom can't render a real terminal) ----
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    open() {}
    write(...a: unknown[]) { h.xtermWrite(...a) }
    paste(data: string) { h.xtermPaste(data); h.dataCb.fn?.(data.replace(/\r?\n/g, '\r')) }
    onData(cb: (d: string) => void) { h.dataCb.fn = cb }
    onSelectionChange() {}
    clearSelection() {}
    clear() {}
    getSelection() { return '' }
    getSelectionPosition() { return { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } } }
    buffer = { active: { viewportY: 0 } }
    loadAddon() {}
    attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean) { h.keyHandler.fn = cb }
    dispose() { h.xtermDispose() }
    focus() {}
    onResize() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} activate() {} dispose() {} },
}))
// addon-webgl touches a real canvas at module load (jsdom has no WebGL) — stub it.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { onContextLoss() {} activate() {} dispose() {} },
}))
// xterm.css import — stub so the bundler/test doesn't choke
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import { TerminalPane } from './TerminalPane'

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

function pasteEvent(text: string): ClipboardEvent {
  const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => kind === 'text/plain' ? text : '' },
  })
  return ev
}

describe('TerminalPane (xterm wiring)', () => {
  beforeEach(() => {
    termOpen.mockClear(); termWrite.mockClear(); termResize.mockClear(); termClose.mockClear()
    listen.mockClear(); xtermWrite.mockClear(); xtermPaste.mockClear(); xtermDispose.mockClear(); h.dataCb.fn = null
    h.keyHandler.fn = null
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).__CATIO_SERVER__
  })

  it('opens a terminal channel and subscribes to term:// events when given a live sessionId', async () => {
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" />)
    await waitFor(() => expect(termOpen).toHaveBeenCalled())
    expect(termOpen).toHaveBeenCalledWith('sess-1', expect.any(Number), expect.any(Number))
    await waitFor(() => expect(listen).toHaveBeenCalled())
    expect(listen.mock.calls[0][0]).toMatch(/^term:\/\//)
    expect(listen.mock.calls[0][0]).toBe('term://chan-1')
  })

  it('forwards keystrokes via termWrite (base64) in live mode', async () => {
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" />)
    await waitFor(() => expect(h.dataCb.fn).not.toBeNull())
    h.dataCb.fn!('a')
    expect(termWrite).toHaveBeenCalledWith('sess-1', 'chan-1', btoa('a'))
  })

  it('pastes clipboard text into the live PTY in desktop mode', async () => {
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active />)
    await waitFor(() => expect(h.dataCb.fn).not.toBeNull())
    termWrite.mockClear()

    const ev = pasteEvent('echo hi')
    window.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(true)
    expect(xtermPaste).toHaveBeenCalledWith('echo hi')
    expect(termWrite).toHaveBeenCalledWith('sess-1', 'chan-1', btoa('echo hi'))
  })

  it('pastes clipboard text into the live PTY in server mode', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    ;(window as unknown as Record<string, unknown>).__CATIO_SERVER__ = true
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active />)
    await waitFor(() => expect(h.dataCb.fn).not.toBeNull())
    termWrite.mockClear()

    const ev = pasteEvent('pwd')
    window.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(true)
    expect(xtermPaste).toHaveBeenCalledWith('pwd')
    expect(termWrite).toHaveBeenCalledWith('sess-1', 'chan-1', btoa('pwd'))
  })

  it('blocks ctrl+v from being sent to the PTY as a control character', async () => {
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active />)
    await waitFor(() => expect(h.dataCb.fn).not.toBeNull())
    await waitFor(() => expect(h.keyHandler.fn).not.toBeNull())
    termWrite.mockClear()

    const ev = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    const shouldProcess = h.keyHandler.fn!(ev)

    expect(shouldProcess).toBe(false)
    expect(termWrite).not.toHaveBeenCalledWith('sess-1', 'chan-1', btoa('\x16'))
  })

  it('does not hijack paste events from regular inputs outside the terminal surface', async () => {
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active />)
    await waitFor(() => expect(h.dataCb.fn).not.toBeNull())
    termWrite.mockClear()

    const input = document.createElement('input')
    document.body.appendChild(input)
    const ev = pasteEvent('do-not-paste')
    input.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(false)
    expect(termWrite).not.toHaveBeenCalled()
    input.remove()
  })

  it('uses the latest active state when deciding which mounted pane may paste', async () => {
    const { rerender } = wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active={false} />)
    await waitFor(() => expect(h.dataCb.fn).not.toBeNull())
    termWrite.mockClear()

    window.dispatchEvent(pasteEvent('hidden'))
    expect(termWrite).not.toHaveBeenCalled()

    rerender(<LanguageProvider><DataProvider><TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active /></DataProvider></LanguageProvider>)
    window.dispatchEvent(pasteEvent('shown'))

    expect(termWrite).toHaveBeenCalledWith('sess-1', 'chan-1', btoa('shown'))
  })

  it('refits + resizes the live PTY when the pane becomes active (shown after being hidden)', async () => {
    const { rerender } = wrap(<TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active={false} />)
    // wait for the channel to open so chanIdRef is set
    await waitFor(() => expect(termOpen).toHaveBeenCalled())
    termResize.mockClear()
    // flip to active → the effect fires fit() + termResize() on the next frame
    rerender(<LanguageProvider><DataProvider><TerminalPane conn={DATA.byId['h-bastion']} sessionId="sess-1" active={true} /></DataProvider></LanguageProvider>)
    // requestAnimationFrame is async in jsdom; flush it.
    await act(async () => { await new Promise<void>(r => requestAnimationFrame(() => r())) })
    expect(termResize).toHaveBeenCalledWith('sess-1', 'chan-1', expect.any(Number), expect.any(Number))
  })

  it('does not open a channel in demo mode (no sessionId)', async () => {
    wrap(<TerminalPane conn={DATA.byId['h-bastion']} />)
    // give effects a tick
    await waitFor(() => expect(xtermWrite).toHaveBeenCalled())
    expect(termOpen).not.toHaveBeenCalled()
  })
})
