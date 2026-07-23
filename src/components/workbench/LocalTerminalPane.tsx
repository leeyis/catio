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
import { HistorySuggest } from '../shell/HistorySuggest'
import { installXtermImeInputFix } from './xtermImeInputFix'
import { planHistoryCompletion, type HistoryMatch } from '../shell/historyCompletion'
import { loadHistory } from '../../state/history'
import type { Connection } from '../../services/types'
import { markTerminalChannelExecution } from '../../services/terminalCapture'

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

// inputStart(OSC 633;B)/execStart(633;C):本地 shell 后端据 shell-integration 发出,
// 驱动历史命令候选补全的输入捕获(提示符结束→开始捕获;命令执行→清空候选)。
interface TermEvent { bytesBase64?: string; closed?: boolean; inputStart?: boolean; execStart?: boolean; execEnd?: boolean }

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

// 由一批发往 PTY 的字节增量推进「optimistic 当前输入」模型(与 SSH TerminalPane 同款):
// 跳过 CSI 转义序列;回车/换行清空;退格删末位;Ctrl-U 清空;Ctrl-W 删末词;可见字符追加。
function applyInputDelta(input: string, data: string): string {
  let next = input
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]
    if (ch === '\x1b') {
      if (data[i + 1] === '[') {
        i += 2
        while (i < data.length) {
          const code = data.charCodeAt(i)
          if (code >= 0x40 && code <= 0x7e) break
          i += 1
        }
      }
      continue
    }
    if (ch === '\r' || ch === '\n') { next = ''; continue }
    if (ch === '\x7f' || ch === '\b') { next = next.slice(0, -1); continue }
    if (ch === '\x15') { next = ''; continue }
    if (ch === '\x17') { next = next.replace(/\s*\S+\s*$/, ''); continue }
    const code = ch.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) next += ch
  }
  return next
}

/** 读取本地 shell 历史,按连接名筛选、排除失败命令,供补全引擎使用。 */
function loadLocalShellHistory(connName: string): { text: string; ts: number }[] {
  try {
    return loadHistory()
      .filter(h => h.kind === 'shell' && h.target === connName && (h.exitCode === undefined || h.exitCode === 0))
      .map(h => ({ text: h.text, ts: h.ts ?? 0 }))
  } catch { return [] }
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

  // ---- 历史命令候选补全(仅本地 shell,依赖后端 OSC 633 inputStart/execStart 帧) ----
  const [suggest, setSuggest] = useState<{ items: HistoryMatch[]; left: number; top: number; flipUp: boolean; input: string } | null>(null)
  const [suggestIndex, setSuggestIndex] = useState(0)
  const [ghost, setGhost] = useState<{ text: string; left: number; top: number } | null>(null)
  // 指令提示开关(本地自持;截图右上角开关控制候选是否弹出)。
  const [historySuggestEnabled, setHistorySuggestEnabled] = useState(true)
  const historySuggestEnabledRef = useRef(historySuggestEnabled)
  historySuggestEnabledRef.current = historySuggestEnabled
  // 输入捕获状态:提示符结束处 marker + 起始列;optimistic 击键模型;Esc 抑制串。
  const inputMarkerRef = useRef<{ marker: { line: number; dispose(): void; isDisposed?: boolean } | null; startCol: number } | null>(null)
  const currentInputRef = useRef<string>('')
  const optimisticInputRef = useRef<string>('')
  const suppressedInputRef = useRef<string | null>(null)
  // 供键盘处理器读取最新候选/选中项(避免闭包捕获旧值)。
  const suggestRef = useRef(suggest)
  suggestRef.current = suggest
  const suggestIndexRef = useRef(suggestIndex)
  suggestIndexRef.current = suggestIndex
  // 接受候选的最新实现(在 effect 内定义,存 ref 供键盘处理器调用)。
  const acceptHistoryMatchRef = useRef<(sel: HistoryMatch | undefined, fallbackInput: string) => void>(() => {})

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
    // rAF 合帧(与 SSH TerminalPane 同款):高频输出把一次刷新拆成大量 term:// 数据帧,逐帧
    // term.write 会打满主线程 + WebGL 重绘、多分屏并发时卡死。纯数据帧攒批一帧内合并成单次
    // write;inputStart/execStart/closed 时序敏感的控制帧先 flush 再处理,交互语义零损失。
    let pendingWriteBytes: Uint8Array[] = []
    let writeFlushRaf: number | null = null
    const rafFn: (cb: () => void) => number =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16) as unknown as number
    const cancelRafFn: (id: number) => void =
      typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id) => clearTimeout(id)

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
    const imeInputFix = installXtermImeInputFix(term)
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

        // ---- 历史命令候选:输入捕获(与 SSH TerminalPane 同款,简化版) ----
        let extractTimer: ReturnType<typeof setTimeout> | null = null
        const BACKSPACE = '\x7f'
        const clearInputCapture = () => {
          try { inputMarkerRef.current?.marker?.dispose() } catch { /* best-effort */ }
          inputMarkerRef.current = null
          currentInputRef.current = ''
          optimisticInputRef.current = ''
          suppressedInputRef.current = null
          setSuggest(null); setGhost(null)
        }
        const beginInputCapture = () => {
          try {
            const buf = term.buffer.active
            const startCol = typeof buf.cursorX === 'number' ? buf.cursorX : 0
            const marker = typeof term.registerMarker === 'function' ? term.registerMarker(0) : null
            inputMarkerRef.current = { marker: marker as never, startCol }
            currentInputRef.current = ''
            optimisticInputRef.current = ''
            suppressedInputRef.current = null
          } catch { inputMarkerRef.current = null }
        }
        const readCurrentInput = (): string | null => {
          const cap = inputMarkerRef.current
          if (!cap) return null
          try {
            const buf = term.buffer.active
            const marker = cap.marker
            if (marker && marker.isDisposed) return null
            const startLine = marker && typeof marker.line === 'number' ? marker.line : buf.cursorY + buf.baseY
            const endLine = buf.cursorY + buf.baseY
            const endCol = typeof buf.cursorX === 'number' ? buf.cursorX : 0
            let out = ''
            for (let ln = startLine; ln <= endLine; ln++) {
              const line = buf.getLine(ln)
              if (!line) continue
              const full = line.translateToString(true)
              if (ln === startLine && ln === endLine) out += full.slice(cap.startCol, endCol)
              else if (ln === startLine) out += full.slice(cap.startCol)
              else if (ln === endLine) out += '\n' + full.slice(0, endCol)
              else out += '\n' + full
            }
            return out
          } catch { return null }
        }
        const reconcileInput = (screen: string | null, fallback: string): string => {
          const opt = optimisticInputRef.current
          let chosen: string
          if (screen == null) chosen = opt || fallback
          else if (!opt) chosen = screen
          else if (opt.startsWith(screen) || screen.startsWith(opt)) chosen = opt
          else chosen = screen
          optimisticInputRef.current = chosen
          currentInputRef.current = chosen
          return chosen
        }
        const computeSuggestPos = (): { left: number; top: number; flipUp: boolean } | null => {
          const root = rootRef.current
          if (!root) return null
          try {
            const rootRect = root.getBoundingClientRect()
            const hostRect = hostEl.getBoundingClientRect()
            const buf = term.buffer.active
            const cellW = hostEl.clientWidth / term.cols
            const cellH = hostEl.clientHeight / term.rows
            const rowInView = Math.max(0, (buf.cursorY ?? 0))
            const left = hostRect.left + (buf.cursorX ?? 0) * cellW - rootRect.left
            const belowTopPx = (rowInView + 1) * cellH
            const flipUp = belowTopPx + 200 > hostEl.clientHeight
            const anchorPx = flipUp ? rowInView * cellH : belowTopPx
            const top = hostRect.top + anchorPx - rootRect.top
            return { left: Math.max(left, 0), top, flipUp }
          } catch { return null }
        }
        const computeGhostPos = (ghostText: string, input: string): { left: number; top: number } | null => {
          if (!ghostText || input.includes('\n')) return null
          const root = rootRef.current
          if (!root) return null
          try {
            const rootRect = root.getBoundingClientRect()
            const hostRect = hostEl.getBoundingClientRect()
            const buf = term.buffer.active
            const cellW = hostEl.clientWidth / term.cols
            const cellH = hostEl.clientHeight / term.rows
            const cursorX = buf.cursorX ?? 0
            if (cursorX + ghostText.length > term.cols) return null
            const rowInView = Math.max(0, (buf.cursorY ?? 0))
            const left = hostRect.left + cursorX * cellW - rootRect.left
            const top = hostRect.top + rowInView * cellH - rootRect.top
            return { left, top }
          } catch { return null }
        }
        const refreshSuggest = () => {
          if (proto !== 'local' || !historySuggestEnabledRef.current) { setSuggest(null); setGhost(null); return }
          const screenInput = readCurrentInput()
          if (screenInput == null) { clearInputCapture(); return }
          const input = reconcileInput(screenInput, '')
          if (suppressedInputRef.current != null && suppressedInputRef.current === input) { setSuggest(null); setGhost(null); return }
          if (suppressedInputRef.current != null && suppressedInputRef.current !== input) suppressedInputRef.current = null
          if (!input) { setSuggest(null); setGhost(null); return }
          const entries = loadLocalShellHistory(conn.name)
          const { items, ghost: ghostSuffix } = planHistoryCompletion(input, entries, { limit: 8 })
          if (!items.length) { setSuggest(null); setGhost(null); return }
          const pos = computeSuggestPos()
          if (!pos) { setSuggest(null); setGhost(null); return }
          setSuggest({ items, left: pos.left, top: pos.top, flipUp: pos.flipUp, input })
          setSuggestIndex(0)
          const gpos = ghostSuffix ? computeGhostPos(ghostSuffix, input) : null
          setGhost(gpos ? { text: ghostSuffix as string, left: gpos.left, top: gpos.top } : null)
        }
        const scheduleInputRefresh = () => {
          if (!inputMarkerRef.current) return
          if (extractTimer) clearTimeout(extractTimer)
          extractTimer = setTimeout(() => { extractTimer = null; refreshSuggest() }, 40)
        }
        // 接受一条候选(确定性改写命令行):前缀命中只补差额;输入更长则退格;否则清空再写。
        const acceptHistoryMatch = (sel: HistoryMatch | undefined, fallbackInput: string) => {
          if (!sel || !chanIdRef.current) return
          const writePty = (s: string) => { if (chanIdRef.current) termLocalWrite(chanIdRef.current, bytesToBase64(s)) }
          const base = reconcileInput(readCurrentInput(), fallbackInput)
          if (sel.text.startsWith(base)) {
            const tail = sel.text.slice(base.length)
            if (tail) writePty(tail)
          } else if (base.startsWith(sel.text)) {
            writePty(BACKSPACE.repeat(base.length - sel.text.length))
          } else {
            if (base.length) writePty(BACKSPACE.repeat(base.length))
            writePty(sel.text)
          }
          currentInputRef.current = sel.text
          optimisticInputRef.current = sel.text
          setSuggest(null); setGhost(null)
        }
        acceptHistoryMatchRef.current = acceptHistoryMatch

        // 把攒批的数据帧合并成单次 term.write。onDone 在写入被 xterm 处理后回调(inputStart
        // 时序:提示符字节写完、光标就位后才 beginInputCapture)。
        const flushPendingWrite = (onDone?: () => void) => {
          if (writeFlushRaf !== null) { cancelRafFn(writeFlushRaf); writeFlushRaf = null }
          if (pendingWriteBytes.length === 0) {
            if (onDone) { try { term.write('', onDone) } catch { /* disposed */ } }
            return
          }
          let total = 0
          for (const b of pendingWriteBytes) total += b.length
          const merged = new Uint8Array(total)
          let off = 0
          for (const b of pendingWriteBytes) { merged.set(b, off); off += b.length }
          pendingWriteBytes = []
          try { term.write(merged, onDone) } catch { /* disposed */ }
        }
        const scheduleDataFrame = (bytes: Uint8Array) => {
          pendingWriteBytes.push(bytes)
          if (writeFlushRaf === null) {
            writeFlushRaf = rafFn(() => { writeFlushRaf = null; flushPendingWrite(() => scheduleInputRefresh()) })
          }
        }

        unlisten = await listen<TermEvent>(`term://${chanId}`, (p) => {
          try {
            if (p.execStart) markTerminalChannelExecution(chanId, true)
            if (p.execEnd || p.closed) markTerminalChannelExecution(chanId, false)
            if (typeof p.bytesBase64 === 'string') {
              const bytes = base64ToBytes(p.bytesBase64)
              if (p.inputStart) {
                // inputStart 与提示符字节同帧:连同已攒批数据一起立即 flush,在合并 write 的
                // 回调里(光标已落到输入起点)才 beginInputCapture,否则 startCol 记错 → 候选永不出。
                pendingWriteBytes.push(bytes)
                flushPendingWrite(() => { beginInputCapture(); scheduleInputRefresh() })
              } else {
                // 纯数据帧:攒进队列,rAF 合并成单次 write(压掉高频输出的主线程堆积)。
                scheduleDataFrame(bytes)
              }
            } else if (p.inputStart) {
              // 单发的 inputStart 帧(提示符结束、OSC 恰好跨 read chunk):先 flush 已攒批数据,
              // 在其回调里(此前字节都已处理、光标就位)才捕获 marker。
              flushPendingWrite(() => { beginInputCapture(); scheduleInputRefresh() })
            } else if (p.execStart) {
              // 命令开始执行:先 flush 保证顺序,再清掉输入捕获、隐藏候选。
              flushPendingWrite()
              clearInputCapture()
            } else if (p.closed) {
              flushPendingWrite()
              term.write(`\r\n\x1b[2m[${t('localTerm.closed')}]\x1b[0m\r\n`)
              clearInputCapture()
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
          if (!chanIdRef.current) return
          termLocalWrite(chanIdRef.current, bytesToBase64(d))
          // optimistic 击键模型:记录已发往 PTY 的输入,供补全对账;然后节流刷新候选。
          if (inputMarkerRef.current) {
            const next = applyInputDelta(optimisticInputRef.current || currentInputRef.current, d)
            optimisticInputRef.current = next
            currentInputRef.current = next
            scheduleInputRefresh()
          }
        })
        // 键盘导航候选:↑↓ 移动、→ 接受补全、Esc 关闭;候选不可见时一律放行给 PTY。
        if (typeof term.attachCustomKeyEventHandler === 'function') {
          term.attachCustomKeyEventHandler((ev) => {
            if (imeInputFix.handleKeyEvent(ev)) return false
            if (ev.type !== 'keydown') return true
            if (!historySuggestEnabledRef.current) return true
            const sg = suggestRef.current
            if (!sg || !sg.items.length) return true
            const swallow = () => { try { ev.preventDefault(); ev.stopPropagation() } catch { /* noop */ } try { term.focus() } catch { /* best-effort */ } return false }
            const idx = suggestIndexRef.current
            switch (ev.key) {
              case 'ArrowUp': setSuggestIndex(i => (i - 1 + sg.items.length) % sg.items.length); return swallow()
              case 'ArrowDown': setSuggestIndex(i => (i + 1) % sg.items.length); return swallow()
              case 'ArrowRight': acceptHistoryMatchRef.current(sg.items[idx], sg.input); return swallow()
              case 'Escape': suppressedInputRef.current = currentInputRef.current; setSuggest(null); setGhost(null); return swallow()
              default: return true
            }
          })
        }
        // 选区浮动工具栏:鼠标松开后若有选中文本,定位并弹出「复制 / 问 AI」。
        // 与 SSH TerminalPane 同款:getSelectionPosition 在 xterm 6.x 下可能返回 undefined,
        // 此时退回顶部居中锚定(而非不显示);有 pos 时按选区起始行(减 viewportY)定位。
        const onSelMouseUp = () => {
          setTimeout(() => {
            const sel = term.getSelection()
            const root = rootRef.current
            if (!sel || !sel.trim() || !root) { setSelBar(null); return }
            const rootRect = root.getBoundingClientRect()
            const hostRect = hostEl.getBoundingClientRect()
            const pos = term.getSelectionPosition()
            if (!pos) {
              // 无选区坐标:顶部居中兜底,保证按钮一定出现。
              setSelBar({ x: hostRect.width / 2 - 60, y: 30, text: sel.trim() })
              return
            }
            const cellW = hostEl.clientWidth / term.cols
            const cellH = hostEl.clientHeight / term.rows
            const viewportY = term.buffer.active.viewportY
            const rowInView = Math.max(0, pos.start.y - viewportY)
            const x = (hostRect.left - rootRect.left) + ((pos.start.x + pos.end.x) / 2) * cellW
            const y = (hostRect.top - rootRect.top) + rowInView * cellH
            setSelBar({ x, y, text: sel.trim() })
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
      if (writeFlushRaf !== null) { cancelRafFn(writeFlushRaf); writeFlushRaf = null }
      pendingWriteBytes = []
      if (ro) ro.disconnect()
      if (unlisten) unlisten()
      if (unlistenHist) unlistenHist()
      if (chanIdRef.current) markTerminalChannelExecution(chanIdRef.current, false)
      if (chanIdRef.current) { termLocalClose(chanIdRef.current); chanIdRef.current = null }
      onChannelRef.current?.(null)
      imeInputFix.dispose()
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
      const detail = (e as CustomEvent<{ kind?: string; text?: string }>).detail
      if (detail?.kind === 'shell' && typeof detail.text === 'string') writeToPty(detail.text)
    }
    function onRun(e: Event) {
      if (!activeRef.current) return
      const detail = (e as CustomEvent<{ kind?: string; text?: string }>).detail
      if (detail?.kind === 'shell' && typeof detail.text === 'string') { writeToPty(detail.text); writeToPty('\r') }
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
        {/* 工具栏:指令提示开关(仅本地 shell)+ 清屏 + 左右/上下分屏(与 SSH 终端一致)。 */}
        <div className="row gap8" style={{ flex: 'none' }}>
          {proto === 'local' && (
            <button className="icon-btn bare" aria-pressed={historySuggestEnabled}
              title={t(historySuggestEnabled ? 'workbench.disableHistorySuggest' : 'workbench.enableHistorySuggest')}
              // mousedown 阻止默认,避免点击时 xterm 隐藏 textarea 失焦 → 之后无法输入(Codex 诊断的根因2)。
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setHistorySuggestEnabled(v => !v)
                // 兜底:键盘激活按钮时 mousedown 不触发,点击后把焦点收回终端。
                requestAnimationFrame(() => { try { termRef.current?.focus() } catch { /* disposed */ } })
              }}
              style={{ color: historySuggestEnabled ? 'var(--accent-primary)' : undefined }}>
              <Icon name="command" size={15} />
            </button>
          )}
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
      {/* 历史命令候选下拉(→ 接受、↑↓ 选择、Esc 关闭)。 */}
      {suggest && (
        <HistorySuggest
          items={suggest.items}
          selectedIndex={suggestIndex}
          left={suggest.left}
          top={suggest.top}
          flipUp={suggest.flipUp}
          input={suggest.input}
          onPick={i => acceptHistoryMatchRef.current(suggest.items[i], suggest.input)}
        />
      )}
      {/* 幽灵文本:严格前缀命中时,在光标处显示灰色补全后缀。 */}
      {ghost && (
        <div className="mono" style={{ position: 'absolute', left: ghost.left, top: ghost.top, zIndex: 27, pointerEvents: 'none', color: 'var(--text-faint)', fontSize: prefs.termFontPx, lineHeight: 1, whiteSpace: 'pre' }}>
          {ghost.text}
        </div>
      )}
    </div>
  )
}
