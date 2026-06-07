/* ported from ref-ui/_extract/blob7.txt — chrome verbatim; middle surface swapped to xterm.js (A10) */
import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Icon } from '../Icon'
import { ConnGlyph, StatusDot } from '../atoms'
import { useData } from '../../state/DataContext'
import { termOpen, termWrite, termResize, termClose, listen, getTermBuffer, multiexecRun } from '../../services/ssh'
import type { Connection, TermLine as TermLineType, MultiExecTarget } from '../../services/types'

export interface TerminalPaneProps {
  conn: Connection | null
  /** When set AND running under Tauri, the terminal is "live" (wired to term_* IPC). */
  sessionId?: string
  /**
   * ORCH seam: maps a connection id to its live session id.
   * When provided, the Multi-Exec broadcast bar uses real multiexecRun IPC.
   * When absent (pre-ORCH), broadcast stays UI-only (existing behavior).
   * ORCH will pass this once the connection→session map is managed centrally.
   */
  resolveSessionId?: (connId: string) => string | undefined
}

// Tauri detection — mirror services/ssh.ts guard (not exported there).
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// term:// event payload shape (A7 contract): data frame OR close notice.
interface TermEvent { bytesBase64?: string; closed?: boolean }

// UTF-8 string -> base64 (keystrokes out)
function bytesToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
// base64 -> Uint8Array (data frames in)
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

// Render a mock TermLine[] to plain text for the read-only demo surface.
function termLinesToText(lines: TermLineType[]): string {
  return lines
    .filter(l => !l.cursor)
    .map(l => {
      if (l.t === 'prompt') return `\x1b[32m${l.host ?? ''}\x1b[0m:\x1b[34m${l.path ?? '~'}\x1b[0m$ ${l.cmd ?? ''}`
      if (l.t === 'sys') return `\x1b[2m＊ ${l.s ?? ''}\x1b[0m`
      if (l.t === 'err') return `\x1b[31m${l.s ?? ''}\x1b[0m`
      return l.s ?? ''
    })
    .join('\r\n')
}

// Per-target state for an active multiexec run (held but not yet rendered — ORCH will surface it).
// Shape matches MultiExecTarget so the ORCH task can pass it directly to a results panel.
type MxRunState = Record<string, MultiExecTarget>

export function TerminalPane({ conn, sessionId, resolveSessionId }: TerminalPaneProps) {
  const { t } = useTranslation()
  const D = useData()
  const [broadcast, setBroadcast] = useState(false)
  const [mxOpen, setMxOpen] = useState(false)
  const selfId = conn ? conn.id : 'h-bastion'
  const selfProto = conn ? (conn.proto || 'ssh') : 'ssh'
  // Broadcast targets must match the ACTIVE tab: same kind (host) AND same protocol —
  // you can't broadcast a shell command to a database node or a different transport.
  const allHosts = useMemo(() => D.connections.filter(c => c.kind === 'host' && (c.proto || 'ssh') === selfProto && c.status !== 'down'), [D.connections, selfProto])
  const [mxHosts, setMxHosts] = useState(() => allHosts.filter(h => h.id !== selfId).slice(0, 2).map(h => h.id))
  const rootRef = useRef<HTMLDivElement>(null)
  const xtermHost = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Mutable ref tracking the active channel id; nulled on server-initiated close to
  // prevent double-termClose and dead-channel keystroke writes.
  const chanIdRef = useRef<string | null>(null)
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string } | null>(null)
  // Multiexec run state — per-target progress; held here for ORCH to consume via a future prop/callback.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_mxRunState, setMxRunState] = useState<MxRunState>({})

  const host = conn ? (conn.sub.split(' ')[0].replace('ssh ', '')) : 'jump@db-bastion'
  const live = !!sessionId && isTauri()

  /**
   * broadcastCommand — sends `cmd` to all selected broadcast hosts.
   *
   * When `resolveSessionId` is provided (ORCH seam), resolves connection ids to
   * session ids and calls multiexecRun. Also includes the current session if live.
   * When `resolveSessionId` is absent, falls back to UI-only broadcast (no IPC) —
   * the terminal itself will send the command via the existing onData handler.
   *
   * ORCH: call this from the keystroke handler / send button once the session
   * map is available. e.g.: broadcastCommand(currentLine) before termWrite.
   */
  // ORCH seam: call broadcastCommandRef.current(cmd) from the keystroke handler once
  // resolveSessionId is wired. Stored in a ref so the caller always has the latest closure.
  const broadcastCommandRef = useRef<(cmd: string) => Promise<void>>(async () => { /* pre-ORCH no-op */ })
  broadcastCommandRef.current = async (cmd: string) => {
    if (!resolveSessionId) {
      // Pre-ORCH: broadcast is UI-only; the keystroke handler already writes to the
      // current terminal. No multiexec IPC yet.
      return
    }
    const targetIds: string[] = []
    // Include the current session if live.
    if (sessionId && live) targetIds.push(sessionId)
    // Resolve selected broadcast hosts to session ids.
    for (const connId of mxHosts) {
      const sid = resolveSessionId(connId)
      if (sid) targetIds.push(sid)
    }
    if (targetIds.length === 0) return

    // Initialise run state for all targets.
    const initial: MxRunState = {}
    for (const connId of mxHosts) {
      initial[connId] = { id: connId, name: D.byId[connId]?.name ?? connId, state: 'running', out: '' }
    }
    setMxRunState(initial)

    try {
      const runId = await multiexecRun(targetIds, cmd)
      const unlisten = await listen<{ sessionId: string; state: 'running' | 'done' | 'error'; chunk?: string }>(
        'multiexec://' + runId,
        (ev) => {
          setMxRunState(prev => {
            // Find the connId that maps to this sessionId.
            const connId = mxHosts.find(id => resolveSessionId(id) === ev.sessionId) ?? ev.sessionId
            const existing = prev[connId] ?? { id: connId, name: connId, state: 'running', out: '' }
            return {
              ...prev,
              [connId]: {
                ...existing,
                state: ev.state,
                out: existing.out + (ev.chunk ?? ''),
              },
            }
          })
        },
      )
      // Unlisten once all targets have reported done or error.
      // A 30-second timeout is a safe fallback; ORCH can replace this.
      setTimeout(() => unlisten(), 30_000)
    } catch {
      // best-effort; ORCH will add proper error surfaces
    }
  }

  // ---- xterm lifecycle (once per session/chan) ----
  useEffect(() => {
    const hostEl = xtermHost.current
    if (!hostEl) return
    let disposed = false
    let unlisten: (() => void) | null = null
    chanIdRef.current = null
    let ro: ResizeObserver | null = null

    const term = new Terminal({
      theme: { background: cssVar('--term-bg', '#0B1020'), foreground: cssVar('--term-fg', '#E2E8F0') },
      fontFamily: "'Geist Mono', monospace",
      fontSize: 12.5,
      cursorBlink: true,
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(hostEl)
    try { fitAddon.fit() } catch { /* jsdom has no layout */ }

    // Selection toolbar (copy / ask AI) — driven by xterm's own selection.
    term.onSelectionChange(() => {
      const text = term.getSelection()
      if (!text || !text.trim() || !rootRef.current || !hostEl) { setSelBar(null); return }
      const root = rootRef.current
      const rootRect = root.getBoundingClientRect()
      const hostRect = hostEl.getBoundingClientRect()
      const scale = (rootRect.width / root.offsetWidth) || 1
      const left = (hostRect.left + hostRect.width / 2 - rootRect.left) / scale
      // xterm.js exposes no selection pixel coords; toolbar is anchored near the top of
      // the surface rather than at the selection. Known limitation vs the old DOM renderer.
      const top = (hostRect.top + 24 - rootRect.top) / scale
      setSelBar({ left, top, text: text.trim() })
    })

    if (live && sessionId) {
      // ---- LIVE: wire to term_* IPC ----
      ;(async () => {
        const openedChanId = await termOpen(sessionId, term.cols, term.rows)
        chanIdRef.current = openedChanId
        if (disposed) { termClose(sessionId, openedChanId); chanIdRef.current = null; return }
        unlisten = await listen<TermEvent>(`term://${openedChanId}`, (p) => {
          if (typeof p.bytesBase64 === 'string') {
            term.write(base64ToBytes(p.bytesBase64))
          } else if (p.closed) {
            // Server-initiated close: write notice, close channel, then mark it dead so
            // keystrokes and unmount cleanup don't call termClose on a dead channel.
            term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n')
            if (chanIdRef.current) { termClose(sessionId, chanIdRef.current); chanIdRef.current = null }
          }
        })
        if (disposed) { unlisten(); if (chanIdRef.current) { termClose(sessionId, chanIdRef.current); chanIdRef.current = null } return }
        term.onData(d => {
          // Drop keystrokes after a server-initiated close (channel already torn down).
          if (!chanIdRef.current) return
          termWrite(sessionId, chanIdRef.current, bytesToBase64(d))
        })
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(() => {
            try { fitAddon.fit() } catch { /* no layout */ }
            if (chanIdRef.current) termResize(sessionId, chanIdRef.current, term.cols, term.rows)
          })
          ro.observe(hostEl)
        }
      })()
    } else {
      // ---- DEMO: read-only mock buffer, no IPC wiring ----
      ;(async () => {
        const buf = await getTermBuffer(conn ? conn.id : 'h-bastion')
        if (disposed) return
        term.write(termLinesToText(buf))
      })()
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => { try { fitAddon.fit() } catch { /* no layout */ } })
        ro.observe(hostEl)
      }
    }

    return () => {
      disposed = true
      if (ro) ro.disconnect()
      if (unlisten) unlisten()
      // Only call termClose if the channel is still live (not already closed by server).
      if (live && sessionId && chanIdRef.current) { termClose(sessionId, chanIdRef.current); chanIdRef.current = null }
      term.dispose()
      termRef.current = null
    }
    // re-init when the session/chan identity changes
  }, [sessionId, live, conn])

  function copySel() {
    if (selBar && navigator.clipboard) navigator.clipboard.writeText(selBar.text).catch(() => {})
    setSelBar(null)
  }
  function askSelAI() {
    if (selBar) window.dispatchEvent(new CustomEvent('catio-ask-ai', { detail: { text: selBar.text, target: conn ? conn.name : 'db-bastion', kind: 'shell' } }))
    setSelBar(null)
    if (termRef.current) termRef.current.clearSelection()
  }

  const displayConn = conn || D.byId['h-bastion']

  return (
    <div ref={rootRef} className="col" style={{ height: '100%', minHeight: 0, position: 'relative' }}>
      {/* term toolbar */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
        <div className="row gap8">
          <ConnGlyph conn={displayConn} size={26} radius={7} />
          <div className="col" style={{ lineHeight: 1.2 }}>
            <span className="row gap6" style={{ fontSize: 13, fontWeight: 600 }}>{conn ? conn.name : 'db-bastion'} <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 400 }}>ssh-ed25519</span></span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{host} · xterm-256color</span>
          </div>
          <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 13%, transparent)', color: 'var(--signal-green)' }}><span className="dot" style={{ background: 'var(--signal-green)' }} /> connected</span>
        </div>
        <div className="row gap6">
          <div style={{ position: 'relative' }}>
            <button onClick={() => setMxOpen(o => !o)}
              className="chip" style={{ cursor: 'pointer', height: 28, background: broadcast ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: broadcast ? 'var(--accent-primary)' : 'var(--text-tertiary)', fontWeight: 600 }}>
              <Icon name="radar" size={12} /> Multi-Exec{broadcast && mxHosts.length ? ` · ${mxHosts.length + 1} ${t('workbench.machines')}` : ''}
              <Icon name="chevron-down" size={11} style={{ transition: 'transform .15s', transform: mxOpen ? 'rotate(180deg)' : 'none' }} />
            </button>
            {mxOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMxOpen(false)} />
                <div className="pop-in col" style={{ position: 'absolute', top: 34, right: 0, zIndex: 50, width: 254, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 12, boxShadow: 'var(--shadow-dropdown)', overflow: 'hidden' }}>
                  <div className="col" style={{ padding: '10px 12px 8px', gap: 4 }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t('workbench.broadcastTargetHosts')}</span>
                      <span className="badge-accent">{mxHosts.length + 1} {t('workbench.machines')}</span>
                    </div>
                    <span className="row gap5" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                      <Icon name="info" size={11} /> {t('workbench.sameProtoOnly')} · <span className="mono" style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{selfProto}</span>
                    </span>
                  </div>
                  <div className="col" style={{ padding: '0 6px 6px', maxHeight: 240, overflowY: 'auto' }}>
                    {/* current host — pinned, always included */}
                    <div className="row gap8" style={{ padding: '7px 8px', borderRadius: 8, opacity: 0.85 }}>
                      <ConnGlyph conn={displayConn} size={24} radius={6} />
                      <div className="col grow" style={{ lineHeight: 1.2, minWidth: 0 }}>
                        <span className="ell" style={{ fontSize: 12.5, fontWeight: 600 }}>{conn ? conn.name : 'db-bastion'}</span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{t('workbench.currentSession')}</span>
                      </div>
                      <span className="chip" style={{ height: 19, fontSize: 9.5, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="lock" size={9} /> {t('workbench.locked')}</span>
                    </div>
                    <div style={{ height: 1, background: 'var(--border-hairline)', margin: '3px 6px' }} />
                    {allHosts.filter(h => h.id !== selfId).map(h => {
                      const on = mxHosts.includes(h.id)
                      return (
                        <button key={h.id} onClick={() => setMxHosts(s => on ? s.filter(x => x !== h.id) : [...s, h.id])}
                          className="row gap8" style={{ padding: '7px 8px', borderRadius: 8, background: on ? 'var(--accent-soft-alt)' : 'transparent' }}
                          onMouseEnter={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-sunken)' }} onMouseLeave={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}>
                          <span style={{ width: 17, height: 17, borderRadius: 5, flex: 'none', display: 'grid', placeItems: 'center', background: on ? 'var(--accent-primary)' : 'transparent', border: on ? 'none' : '1.5px solid var(--border-hairline-alt)' }}>
                            {on && <Icon name="check" size={12} style={{ color: 'var(--on-accent)' }} />}
                          </span>
                          <ConnGlyph conn={h} size={24} radius={6} />
                          <div className="col grow" style={{ lineHeight: 1.2, minWidth: 0, textAlign: 'left' }}>
                            <span className="ell" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>{h.name}</span>
                            <span className="ell mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{h.sub}</span>
                          </div>
                          <StatusDot status={h.status} size={6} />
                        </button>
                      )
                    })}
                    {allHosts.filter(h => h.id !== selfId).length === 0 && (
                      <div className="col" style={{ alignItems: 'center', gap: 6, padding: '16px 8px', color: 'var(--text-faint)' }}>
                        <Icon name="server" size={20} />
                        <span style={{ fontSize: 11.5, textAlign: 'center' }}>{t('workbench.noBroadcastHosts', { proto: selfProto.toUpperCase() })}</span>
                      </div>
                    )}
                  </div>
                  <div className="row gap6" style={{ padding: '8px 10px', borderTop: '1px solid var(--border-hairline)' }}>
                    <button className="btn btn-ghost sm" style={{ flex: 1 }} onClick={() => setMxHosts([])}>{t('workbench.clearAll')}</button>
                    <button className="btn btn-primary sm" style={{ flex: 1 }} onClick={() => { setBroadcast(mxHosts.length > 0); setMxOpen(false); }}>
                      <Icon name="radar" size={13} /> {mxHosts.length ? t('workbench.broadcastTo', { count: mxHosts.length + 1 }) : t('workbench.disableBroadcast')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <button className="icon-btn bare" title={t('workbench.searchBuffer')}><Icon name="search" size={15} /></button>
          <button className="icon-btn bare" title={t('workbench.clearScreen')} onClick={() => { if (termRef.current) termRef.current.clear() }}><Icon name="trash-2" size={15} /></button>
        </div>
      </div>

      {/* terminal surface — xterm.js host */}
      <div ref={xtermHost} className="grow" onMouseDown={() => setSelBar(null)}
        style={{ overflow: 'hidden', background: 'var(--term-bg)', padding: '12px 14px', fontFamily: "'Geist Mono', monospace", fontSize: 12.5, lineHeight: 1.65, minHeight: 0 }} />

      {/* selection toolbar — copy / ask AI */}
      {selBar && (
        <div className="row gap2 pop-in" style={{ position: 'absolute', left: selBar.left, top: selBar.top - 8, transform: 'translate(-50%, -100%)', zIndex: 25, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 9, boxShadow: 'var(--shadow-dropdown)', padding: 3 }}>
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={copySel}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            <Icon name="copy" size={13} /> {t('workbench.copy')}
          </button>
          <div style={{ width: 1, background: 'var(--border-hairline)', margin: '3px 1px' }} />
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={askSelAI}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>
            <Icon name="sparkles" size={13} /> {t('workbench.askAI')}
          </button>
          <span style={{ position: 'absolute', left: '50%', bottom: -5, transform: 'translateX(-50%) rotate(45deg)', width: 8, height: 8, background: 'var(--surface-elevated)', borderRight: '1px solid var(--border-hairline-alt)', borderBottom: '1px solid var(--border-hairline-alt)' }} />
        </div>
      )}

      {broadcast && mxHosts.length > 0 && (
        <div className="row gap8" style={{ padding: '7px 12px', background: 'var(--accent-soft-alt)', borderTop: '1px solid var(--accent-border)', fontSize: 11.5, color: 'var(--accent-primary)', flexWrap: 'wrap' }}>
          <Icon name="radar" size={13} style={{ flex: 'none' }} />
          <span style={{ fontWeight: 600 }}>{t('workbench.broadcastMode')}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>{t('workbench.broadcastSendTo')}</span>
          <span className="chip" style={{ height: 19, fontSize: 10, background: 'var(--surface-card)', color: 'var(--accent-primary)', fontWeight: 600 }}>{conn ? conn.name : 'db-bastion'}</span>
          {mxHosts.map(id => <span key={id} className="chip" style={{ height: 19, fontSize: 10, background: 'var(--surface-card)', color: 'var(--text-secondary)' }}>{D.byId[id].name}</span>)}
        </div>
      )}
    </div>
  )
}
