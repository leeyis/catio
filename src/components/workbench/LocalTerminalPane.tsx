/* Terminal pane for non-SSH transports: local shell (PTY), serial, telnet.
 * Reuses the xterm core but NOT the SSH machinery (broadcast / OSC history /
 * shell-integration) — those are SSH-shell features. Drives the chosen transport
 * by `conn.proto` over the session-independent term_local_* IPC, sharing the same
 * `term://{chanId}` event protocol as the SSH terminal. */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ConnGlyph } from '../atoms'
import { Icon } from '../Icon'
import { usePrefs, monoFontStack } from '../../state/preferences'
import { copyTextToClipboard } from '../../services/clipboard'
import {
  termOpenLocal, termOpenSerial, termOpenTelnet, termOpenMosh,
  termLocalReady, termLocalWrite, termLocalResize, termLocalClose, listen,
  type HistoryEvent,
} from '../../services/ssh'
import type { Connection } from '../../services/types'

export interface LocalTerminalPaneProps {
  conn: Connection
  active?: boolean
  /** 本地 shell(zsh/bash)命令审计回调:后端经 shell-integration 上报每条已执行命令,
   *  App 追加到历史面板。仅 proto === 'local' 触发(串口/Telnet/Mosh 无 shell hook)。 */
  onHistory?: (e: HistoryEvent) => void
  /** 上报本终端的 chanId(打开时传 id,关闭时传 null),App 写入 chanMap 供历史「插入」按钮判定。 */
  onChannel?: (chanId: string | null) => void
  /** 分屏控制(由 LocalSplitTerminal 注入);缺省时不显示分屏/关闭按钮(单终端)。 */
  split?: {
    count: number
    onSplitRight: () => void
    onSplitDown: () => void
    onClose: () => void
    onDragStart: (e: React.PointerEvent) => void
  }
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

export function LocalTerminalPane({ conn, active, onHistory, onChannel, split }: LocalTerminalPaneProps) {
  const { t } = useTranslation()
  const { prefs } = usePrefs()
  const xtermHost = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const chanIdRef = useRef<string | null>(null)
  // 持最新回调,使 xterm 效应(按 conn.id/proto 键)不因回调身份变化而重建。
  const onHistoryRef = useRef(onHistory)
  onHistoryRef.current = onHistory
  const onChannelRef = useRef(onChannel)
  onChannelRef.current = onChannel
  // active 门控用 ref,避免 catio-insert/run 监听 effect 频繁重挂。
  const activeRef = useRef(active)
  activeRef.current = active
  // 选区浮动工具栏(复制 / 问 AI)。
  const [selBar, setSelBar] = useState<{ x: number; y: number; text: string } | null>(null)

  const proto = conn.proto || 'local'

  // ---- xterm lifecycle (once per terminal identity) ----
  useEffect(() => {
    const hostEl = xtermHost.current
    if (!hostEl) return
    let disposed = false
    let unlisten: (() => void) | null = null
    let unlistenHist: (() => void) | null = null
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
          else if (proto === 'mosh') chanId = await termOpenMosh(conn.host || '', conn.user || '', term.cols, term.rows)
          else chanId = await termOpenLocal(term.cols, term.rows)
        } catch (e) {
          term.write(`\r\n\x1b[31m${t('localTerm.openFailed')}: ${String((e as { message?: string } | null)?.message ?? e)}\x1b[0m\r\n`)
          return
        }
        chanIdRef.current = chanId
        if (disposed) { termLocalClose(chanId); chanIdRef.current = null; return }
        // 上报 channel:App 写入 chanMap[tab.id],使历史面板「插入终端」按钮对本地 tab 生效。
        onChannelRef.current?.(chanId)
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
        // 本地 shell 命令审计:订阅 history://<chanId>,把已执行命令送进历史面板(与 SSH 同源)。
        // 仅本地 shell 装了 hook——串口/Telnet/Mosh 不会 emit,故只在 local 订阅。
        if (proto === 'local' && onHistoryRef.current) {
          unlistenHist = await listen<HistoryEvent>(`history://${chanId}`, e => {
            try { onHistoryRef.current?.(e) } catch { /* best-effort */ }
          })
          if (disposed) { unlistenHist(); unlistenHist = null }
        }
        // Listener is registered → let the backend reader start (avoids losing first output).
        void termLocalReady(chanId)
        term.onData(d => {
          if (chanIdRef.current) termLocalWrite(chanIdRef.current, bytesToBase64(d))
        })
        // 选区浮动工具栏:鼠标松开后若有选中文本,定位并弹出「复制 / 问 AI」。
        const onSelMouseUp = () => {
          setTimeout(() => {
            const sel = term.getSelection()
            const pos = term.getSelectionPosition()
            const root = rootRef.current
            if (!sel || !sel.trim() || !pos || !root) { setSelBar(null); return }
            const rootRect = root.getBoundingClientRect()
            const hostRect = hostEl.getBoundingClientRect()
            const cellH = hostRect.height / term.rows
            const cellW = hostRect.width / term.cols
            // 选区结束点上方偏移,换算到 root 相对坐标。
            const x = (hostRect.left - rootRect.left) + pos.end.x * cellW
            const y = (hostRect.top - rootRect.top) + pos.end.y * cellH
            setSelBar({ x, y, text: sel })
          }, 0)
        }
        hostEl.addEventListener('mouseup', onSelMouseUp)
        // 选区被清空时隐藏(拖选期间 onSelectionChange 抖动,仅用于隐藏)。
        term.onSelectionChange(() => { if (!term.getSelection()) setSelBar(null) })
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
      if (unlistenHist) unlistenHist()
      if (chanIdRef.current) { termLocalClose(chanIdRef.current); chanIdRef.current = null }
      onChannelRef.current?.(null)
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

  // 历史面板/片段的「插入」「执行」按钮 → 当前聚焦的本地终端(与 SSH 终端同款事件总线)。
  // catio-insert 只写入不回车;catio-run 写入后补回车执行。仅当本 pane 显示且聚焦时接收,
  // 避免多终端时误注入到别的 tab。写入走 termLocalWrite(无 sessionId,本地专用)。
  useEffect(() => {
    function writeToPty(text: string) {
      if (chanIdRef.current) termLocalWrite(chanIdRef.current, bytesToBase64(text))
    }
    // 门控只用「当前显示的 tab」(activeRef),不要求终端聚焦——因为点历史面板的
    // 「运行/插入」按钮时终端 textarea 已失焦,若还要求 focused 会导致命令发不出
    // (用户反馈:插入有效、运行无反应)。本地一个 tab 仅一个终端,无分屏误发风险。
    function onInsert(e: Event) {
      if (!activeRef.current) return
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (typeof text === 'string') writeToPty(text)
    }
    function onRun(e: Event) {
      if (!activeRef.current) return
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (typeof text === 'string') { writeToPty(text); writeToPty('\r') }
    }
    window.addEventListener('catio-insert', onInsert)
    window.addEventListener('catio-run', onRun)
    return () => {
      window.removeEventListener('catio-insert', onInsert)
      window.removeEventListener('catio-run', onRun)
    }
  }, [])

  const subtitle = proto === 'serial'
    ? `${conn.serialPort ?? ''} · ${conn.baud ?? 115200} baud`
    : proto === 'telnet'
      ? `telnet ${conn.host ?? ''}:${conn.port ?? 23}`
      : proto === 'mosh'
        ? `mosh ${conn.user ? conn.user + '@' : ''}${conn.host ?? ''}`
        : t('localTerm.localShell')

  // 清屏(纯 xterm,无后端耦合)。
  const clearTerm = () => { try { termRef.current?.clear() } catch { /* disposed */ } }
  // 复制选中文本。
  const copySel = () => { if (selBar) { copyTextToClipboard(selBar.text); setSelBar(null) } }
  // 选中文本问 AI:走与 SSH 终端同款事件总线,detail 只用连接名(不依赖 sessionId)。
  const askSelAI = () => {
    if (selBar) {
      window.dispatchEvent(new CustomEvent('catio-ask-ai', { detail: { text: selBar.text, target: conn.name, kind: 'shell' } }))
      setSelBar(null)
    }
  }

  return (
    <div ref={rootRef} className="col" style={{ height: '100%', minHeight: 0, flex: 1, width: '100%', minWidth: 0, overflow: 'hidden', position: 'relative' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 10 }}>
        <div className="row gap8" style={{ minWidth: 0, overflow: 'hidden' }}>
          <ConnGlyph conn={conn} size={26} radius={7} />
          <div className="col" style={{ lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{conn.name}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{subtitle}</span>
          </div>
        </div>
        {/* 工具栏:清屏 + 左右/上下分屏(与 SSH 终端一致)。分屏按钮由 split prop 驱动。 */}
        <div className="row gap8" style={{ flex: 'none' }}>
          <button className="icon-btn bare" title={t('workbench.clearScreen')} onClick={clearTerm}>
            <Icon name="broom" size={15} />
          </button>
          {split && (
            <>
              <button className="icon-btn bare" title={t('split.splitRight')} onClick={split.onSplitRight}><Icon name="columns" size={15} /></button>
              <button className="icon-btn bare" title={t('split.splitDown')} onClick={split.onSplitDown}><Icon name="rows" size={15} /></button>
              {split.count >= 2 && (
                <>
                  <button className="icon-btn bare" title={t('split.drag')} onPointerDown={split.onDragStart} style={{ cursor: 'grab' }}><Icon name="grip-vertical" size={15} /></button>
                  <button className="icon-btn bare" title={t('split.closePane')} onClick={split.onClose}><Icon name="x" size={15} /></button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div ref={xtermHost} style={{ flex: 1, minHeight: 0, width: '100%' }} />
      {/* 选区浮动工具栏:复制 / 问 AI(定位于选区结束点上方)。 */}
      {selBar && (
        <div className="row gap8" style={{ position: 'absolute', left: Math.max(8, selBar.x), top: Math.max(8, selBar.y - 40), zIndex: 40, padding: '5px 7px', borderRadius: 9, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-dropdown)' }}>
          <button className="btn btn-ghost" onClick={copySel} style={{ fontSize: 12, padding: '3px 8px' }}>
            <Icon name="copy" size={13} /> {t('workbench.copy')}
          </button>
          <button className="btn btn-ghost" onClick={askSelAI} style={{ fontSize: 12, padding: '3px 8px' }}>
            <Icon name="wand" size={13} /> {t('workbench.askAI')}
          </button>
        </div>
      )}
    </div>
  )
}
