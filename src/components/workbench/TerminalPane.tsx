/* ported from ref-ui/_extract/blob7.txt — verbatim per plan T1-T7 */
import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { ConnGlyph, StatusDot } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection, TermLine as TermLineType } from '../../services/types'

export interface TerminalPaneProps {
  conn: Connection | null
}

export function TerminalPane({ conn }: TerminalPaneProps) {
  const { t } = useTranslation()
  const D = useData()
  const [lines, setLines] = useState<TermLineType[]>(D.termLines)
  const [input, setInput] = useState('')
  const [broadcast, setBroadcast] = useState(false)
  const [mxOpen, setMxOpen] = useState(false)
  const selfId = conn ? conn.id : 'h-bastion'
  const selfProto = conn ? (conn.proto || 'ssh') : 'ssh'
  // Broadcast targets must match the ACTIVE tab: same kind (host) AND same protocol —
  // you can't broadcast a shell command to a database node or a different transport.
  const allHosts = useMemo(() => D.connections.filter(c => c.kind === 'host' && (c.proto || 'ssh') === selfProto && c.status !== 'down'), [D.connections, selfProto])
  const [mxHosts, setMxHosts] = useState(() => allHosts.filter(h => h.id !== selfId).slice(0, 2).map(h => h.id))
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string } | null>(null)
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [lines])
  useEffect(() => {
    const h = (e: Event) => {
      const ce = e as CustomEvent
      if (ce.detail && ce.detail.kind === 'shell') setInput(ce.detail.text)
    }
    window.addEventListener('catio-insert', h)
    return () => window.removeEventListener('catio-insert', h)
  }, [])

  function onTermSelect() {
    const selection = window.getSelection()
    const text = selection && selection.toString()
    if (!text || !text.trim() || !scrollRef.current || !rootRef.current) { setSelBar(null); return; }
    if (selection.anchorNode && !scrollRef.current.contains(selection.anchorNode)) { setSelBar(null); return; }
    const rRect = selection.getRangeAt(0).getBoundingClientRect()
    const root = rootRef.current
    const rootRect = root.getBoundingClientRect()
    const scale = (rootRect.width / root.offsetWidth) || 1
    const left = (rRect.left + rRect.width / 2 - rootRect.left) / scale
    const top = (rRect.top - rootRect.top) / scale
    setSelBar({ left, top, text: text.trim() })
  }
  function copySel() {
    if (selBar && navigator.clipboard) navigator.clipboard.writeText(selBar.text).catch(() => {})
    setSelBar(null)
  }
  function askSelAI() {
    if (selBar) window.dispatchEvent(new CustomEvent('catio-ask-ai', { detail: { text: selBar.text, target: conn ? conn.name : 'db-bastion', kind: 'shell' } }))
    setSelBar(null)
    const s = window.getSelection(); if (s) s.removeAllRanges()
  }

  const host = conn ? (conn.sub.split(' ')[0].replace('ssh ', '')) : 'jump@db-bastion'
  function run(cmd: string) {
    if (!cmd.trim()) return
    const base = lines.filter(l => !l.cursor)
    const reply = canned(cmd)
    const next = [...base, { t: 'prompt' as const, host, path: '~', cmd }, ...reply, { t: 'prompt' as const, host, path: '~', cmd: '', cursor: true }]
    setLines(next); setInput('')
  }
  function canned(cmd: string): TermLineType[] {
    const c = cmd.trim()
    if (/^ls/.test(c)) return [{ t: 'out', s: 'releases  shared  public  .env.production  access.log  error.log' }]
    if (/uptime/.test(c)) return [{ t: 'out', s: ' 14:22:51 up 142 days,  3:09,  2 users,  load average: 0.34, 0.41, 0.39' }]
    if (/free/.test(c)) return [{ t: 'out', s: '              total        used        free\nMem:          16039        9624        2104' }]
    if (/redis-cli/.test(c)) return [{ t: 'out', s: '(integer) 1291' }]
    if (/whoami/.test(c)) return [{ t: 'out', s: host.split('@')[0] }]
    if (/clear/.test(c)) { setTimeout(() => setLines([{ t: 'prompt', host, path: '~', cmd: '', cursor: true }]), 0); return [] }
    return [{ t: 'out', s: `${c}: command simulated · Catio demo terminal` }]
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
          <button className="icon-btn bare" title={t('workbench.clearScreen')} onClick={() => setLines([{ t: 'prompt', host, path: '~', cmd: '', cursor: true }])}><Icon name="trash-2" size={15} /></button>
        </div>
      </div>

      {/* terminal surface */}
      <div ref={scrollRef} className="grow" onMouseUp={onTermSelect} onMouseDown={() => setSelBar(null)} onScroll={() => setSelBar(null)}
        style={{ overflow: 'auto', background: 'var(--term-bg)', padding: '12px 14px', fontFamily: "'Geist Mono', monospace", fontSize: 12.5, lineHeight: 1.65 }}>
        {lines.map((l, i) => <TermLine key={i} l={l} onInput={input} setInput={setInput} run={run} />)}
      </div>

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

interface TermLineProps {
  l: TermLineType
  onInput: string
  setInput: (v: string) => void
  run: (cmd: string) => void
}

function TermLine({ l, onInput, setInput, run }: TermLineProps) {
  if (l.t === 'sys') return <div style={{ color: 'var(--term-dim)', marginBottom: 6 }}>＊ {l.s}</div>
  if (l.t === 'out') return <div style={{ color: 'var(--term-fg)', whiteSpace: 'pre-wrap' }}>{l.s}</div>
  if (l.t === 'err') return <div style={{ color: '#F87171', whiteSpace: 'pre-wrap' }}>{l.s}</div>
  // prompt
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <span><span style={{ color: '#4ADE80' }}>{l.host}</span><span style={{ color: 'var(--term-dim)' }}>:</span><span style={{ color: '#60A5FA' }}>{l.path}</span><span style={{ color: 'var(--term-dim)' }}>$</span></span>
      {l.cursor ? (
        <span className="row grow" style={{ minWidth: 80 }}>
          <input autoFocus value={onInput} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run(onInput) }}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--term-fg)', font: 'inherit' }} />
        </span>
      ) : <span style={{ color: 'var(--term-fg)' }}>{l.cmd}</span>}
    </div>
  )
}
