/* Terminal pane for non-SSH transports: local shell (PTY), serial, telnet.
 * Reuses the xterm core but NOT the SSH machinery (broadcast / OSC history /
 * shell-integration) — those are SSH-shell features. Drives the chosen transport
 * by `conn.proto` over the session-independent term_local_* IPC, sharing the same
 * `term://{chanId}` event protocol as the SSH terminal. */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ConnGlyph } from '../atoms'
import { usePrefs, monoFontStack } from '../../state/preferences'
import {
  termOpenLocal, termOpenSerial, termOpenTelnet,
  termLocalReady, termLocalWrite, termLocalResize, termLocalClose, listen,
} from '../../services/ssh'
import type { Connection } from '../../services/types'

export interface LocalTerminalPaneProps {
  conn: Connection
  active?: boolean
}

const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

interface TermEvent { bytesBase64?: string; closed?: boolean }

function bytesToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function LocalTerminalPane({ conn, active }: LocalTerminalPaneProps) {
  const { t } = useTranslation()
  const { prefs } = usePrefs()
  const xtermHost = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const chanIdRef = useRef<string | null>(null)

  const proto = conn.proto || 'local'

  // ---- xterm lifecycle (once per terminal identity) ----
  useEffect(() => {
    const hostEl = xtermHost.current
    if (!hostEl) return
    let disposed = false
    let unlisten: (() => void) | null = null
    let ro: ResizeObserver | null = null
    chanIdRef.current = null

    const term = new Terminal({
      theme: { background: cssVar('--term-bg', '#0B1020'), foreground: cssVar('--term-fg', '#E2E8F0') },
      fontFamily: monoFontStack(prefs.monoFont),
      fontSize: prefs.termFontPx,
      lineHeight: 1.0,
      letterSpacing: 0,
      cursorBlink: true,
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(hostEl)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { try { webgl.dispose() } catch { /* already disposed */ } })
      term.loadAddon(webgl)
    } catch { /* no WebGL → DOM renderer */ }
    const hasSize = () => {
      const r = hostEl.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    if (hasSize()) { try { fit.fit() } catch { /* no layout */ } }

    if (isTauri()) {
      ;(async () => {
        let chanId: string
        try {
          if (proto === 'serial') chanId = await termOpenSerial(conn.serialPort || '', conn.baud || 115200)
          else if (proto === 'telnet') chanId = await termOpenTelnet(conn.host || '', conn.port || 23)
          else chanId = await termOpenLocal(term.cols, term.rows)
        } catch (e) {
          term.write(`\r\n\x1b[31m${t('localTerm.openFailed')}: ${String((e as { message?: string } | null)?.message ?? e)}\x1b[0m\r\n`)
          return
        }
        chanIdRef.current = chanId
        if (disposed) { termLocalClose(chanId); chanIdRef.current = null; return }
        if (active) { try { term.focus() } catch { /* best-effort */ } }
        unlisten = await listen<TermEvent>(`term://${chanId}`, (p) => {
          try {
            if (typeof p.bytesBase64 === 'string') {
              term.write(base64ToBytes(p.bytesBase64))
            } else if (p.closed) {
              term.write(`\r\n\x1b[2m[${t('localTerm.closed')}]\x1b[0m\r\n`)
              if (chanIdRef.current) { termLocalClose(chanIdRef.current); chanIdRef.current = null }
            }
          } catch { /* terminal disposed mid-flight */ }
        })
        if (disposed) { unlisten(); if (chanIdRef.current) { termLocalClose(chanIdRef.current); chanIdRef.current = null } return }
        // Listener is registered → let the backend reader start (avoids losing first output).
        void termLocalReady(chanId)
        term.onData(d => {
          if (chanIdRef.current) termLocalWrite(chanIdRef.current, bytesToBase64(d))
        })
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(() => {
            if (!hasSize()) return
            try { fit.fit() } catch { /* no layout */ }
            if (chanIdRef.current) termLocalResize(chanIdRef.current, term.cols, term.rows)
          })
          ro.observe(hostEl)
        }
      })()
    } else {
      term.write(t('localTerm.demoHint'))
    }

    return () => {
      disposed = true
      if (ro) ro.disconnect()
      if (unlisten) unlisten()
      if (chanIdRef.current) { termLocalClose(chanIdRef.current); chanIdRef.current = null }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, proto])

  // Live-apply font prefs without recreating the terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term || !term.options) return
    term.options.fontSize = prefs.termFontPx
    term.options.fontFamily = monoFontStack(prefs.monoFont)
    try { fitRef.current?.fit() } catch { /* no layout */ }
    if (chanIdRef.current) { try { termLocalResize(chanIdRef.current, term.cols, term.rows) } catch { /* best-effort */ } }
  }, [prefs.termFontPx, prefs.monoFont])

  // When shown, refit to the now-laid-out container and focus.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term) return
    const id = requestAnimationFrame(() => {
      try { fit?.fit() } catch { /* no layout */ }
      if (chanIdRef.current) { try { termLocalResize(chanIdRef.current, term.cols, term.rows) } catch { /* best-effort */ } }
      try { term.focus() } catch { /* best-effort */ }
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  const subtitle = proto === 'serial'
    ? `${conn.serialPort ?? ''} · ${conn.baud ?? 115200} baud`
    : proto === 'telnet'
      ? `telnet ${conn.host ?? ''}:${conn.port ?? 23}`
      : t('localTerm.localShell')

  return (
    <div className="col" style={{ height: '100%', minHeight: 0, flex: 1, width: '100%', minWidth: 0, overflow: 'hidden', position: 'relative' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 10 }}>
        <div className="row gap8" style={{ minWidth: 0, overflow: 'hidden' }}>
          <ConnGlyph conn={conn} size={26} radius={7} />
          <div className="col" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{conn.name}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{subtitle}</span>
          </div>
        </div>
      </div>
      <div ref={xtermHost} style={{ flex: 1, minHeight: 0, width: '100%' }} />
    </div>
  )
}
