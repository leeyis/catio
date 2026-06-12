/* ported from ref-ui/_extract/blob7.txt — chrome verbatim; middle surface swapped to xterm.js (A10) */
import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { Icon } from '../Icon'
import { ConnGlyph, StatusDot } from '../atoms'
import { useData } from '../../state/DataContext'
import { termOpen, termWrite, termResize, termClose, listen, getTermBuffer, multiexecRun } from '../../services/ssh'
import { usePrefs, monoFontStack } from '../../state/preferences'
import { registerTermBuffer, unregisterTermBuffer } from '../../services/termBuffers'
import type { Connection, TermLine as TermLineType, MultiExecTarget } from '../../services/types'
import { loadHistory } from '../../state/history'
import { planHistoryCompletion, type ShellHistoryEntry, type HistoryMatch } from '../shell/historyCompletion'
import { HistorySuggest } from '../shell/HistorySuggest'

export interface TerminalPaneProps {
  conn: Connection | null
  /** When set AND running under Tauri, the terminal is "live" (wired to term_* IPC). */
  sessionId?: string
  /**
   * True when this pane is the currently-shown workbench tab. Panes stay MOUNTED
   * while hidden (display:none) so the live PTY + xterm buffer survive view/tab
   * switches; a hidden container has zero size, so when this turns true we refit
   * + resize the PTY + focus so xterm lays out and redraws correctly.
   */
  active?: boolean
  /**
   * ORCH seam: maps a connection id to its live session id.
   * When provided, the Multi-Exec broadcast bar uses real multiexecRun IPC.
   * When absent (pre-ORCH), broadcast stays UI-only (existing behavior).
   * ORCH will pass this once the connection→session map is managed centrally.
   */
  resolveSessionId?: (connId: string) => string | undefined
  /**
   * Surfaces the live PTY channel id to App so it can write into the active
   * terminal (e.g. snippet/history "insert"). Called with the chanId once
   * termOpen resolves, and with null on close/unmount.
   */
  onChannel?: (sessionId: string, chanId: string | null) => void
}

// Tauri detection — mirror services/ssh.ts guard (not exported there).
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// term:// event payload shape (A7 contract): data frame OR close notice.
// inputStart/execStart carry OSC 633;B / 633;C signals from the backend so the
// frontend knows when the prompt finished (start capturing input) and when a
// command was submitted (hide candidates).
interface TermEvent { bytesBase64?: string; closed?: boolean; inputStart?: boolean; execStart?: boolean }

// 从 conn.sub(`user@host:port`)解析出裸 host/IP。这是后端 term.rs 写入 history.target
// 的口径(s.host),前后两侧用同一字段才能匹配到候选。无 `@` 时整串视为主机段;
// 去掉末尾 `:port`(IPv6 不在此支持范围,真实连接 sub 均为 user@host:port 形)。
function hostFromSub(sub: string): string {
  const afterAt = sub.includes('@') ? sub.slice(sub.lastIndexOf('@') + 1) : sub
  const colon = afterAt.lastIndexOf(':')
  return colon > 0 ? afterAt.slice(0, colon) : afterAt
}

// 当前主机的 shell 历史 → ShellHistoryEntry[]。复用 App.tsx 的写入口径:
// target === host || (conn && target === conn.name)。
function loadShellHistory(host: string, conn: Connection | null): ShellHistoryEntry[] {
  const connName = conn ? conn.name : null
  return loadHistory()
    .filter(h => h.kind === 'shell' && (h.target === host || (connName != null && h.target === connName)))
    .map(h => ({ text: h.text, ts: typeof h.ts === 'number' ? h.ts : 0 }))
}

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

// Dump the full xterm scrollback + viewport to plain text (newline-joined),
// trimming trailing blank lines. Used to feed the Catio Agent recent output.
function dumpTermBuffer(term: Terminal): string {
  try {
    const buf = term.buffer.active
    const out: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      out.push(line ? line.translateToString(true) : '')
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop()
    return out.join('\n')
  } catch {
    return ''
  }
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

export function TerminalPane({ conn, sessionId, active, resolveSessionId, onChannel }: TerminalPaneProps) {
  const { t } = useTranslation()
  const D = useData()
  const { prefs } = usePrefs()
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
  // FitAddon kept in a ref so the "became visible" effect can refit after this
  // pane was hidden (display:none → zero size → xterm can't lay out).
  const fitAddonRef = useRef<FitAddon | null>(null)
  // SearchAddon for buffer search; search UI state (toggle + query).
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Mutable ref tracking the active channel id; nulled on server-initiated close to
  // prevent double-termClose and dead-channel keystroke writes.
  const chanIdRef = useRef<string | null>(null)
  // Keep the latest onChannel in a ref so the xterm lifecycle effect (which depends
  // only on session identity) always calls the current closure without re-running.
  const onChannelRef = useRef<TerminalPaneProps['onChannel']>(onChannel)
  onChannelRef.current = onChannel
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string } | null>(null)
  // ---- 历史补全(Phase 1:候选下拉,无幽灵文本)----
  // suggest:可见时的候选列表 + 坐标;为 null 时不渲染。selectedIndex 单独存以便键盘移动。
  const [suggest, setSuggest] = useState<{ items: HistoryMatch[]; left: number; top: number; flipUp: boolean; input: string } | null>(null)
  const [suggestIndex, setSuggestIndex] = useState(0)
  // ---- Phase 2:行内灰色「幽灵文本」(DOM 浮层,绝不写入终端)----
  // ghost:engine 返回的 items[0] 剩余后缀(仅严格前缀命中时非空);left/top 为光标像素位置。
  // 仅单行输入且不会换行时渲染。
  const [ghost, setGhost] = useState<{ text: string; left: number; top: number } | null>(null)
  // ghost 镜像到 ref,供 attachCustomKeyEventHandler 在按键时同步读取(→/Ctrl+E 接受)。
  const ghostRef = useRef<typeof ghost>(null)
  ghostRef.current = ghost
  // 输入起点标记:OSC 633;B 命中后记录的光标行 marker + 列,用于提取「当前输入」。
  const inputMarkerRef = useRef<{ marker: { line: number; dispose(): void } | null; startCol: number } | null>(null)
  // 本次输入是否被 Esc 忽略(直到输入再次变化才恢复)。
  const suppressedInputRef = useRef<string | null>(null)
  // 最近一次提取到的输入,供键盘交互读取(避免闭包过期)。
  const currentInputRef = useRef<string>('')
  // suggest 状态镜像到 ref,供 attachCustomKeyEventHandler 在按键时同步读取。
  const suggestRef = useRef<typeof suggest>(null)
  suggestRef.current = suggest
  const suggestIndexRef = useRef(0)
  suggestIndexRef.current = suggestIndex
  // Multiexec run state — per-target progress; held here for ORCH to consume via a future prop/callback.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [mxRunState, setMxRunState] = useState<MxRunState>({})
  // The command typed into the broadcast bar (Multi-Exec).
  const [bcCmd, setBcCmd] = useState('')
  const [bcSending, setBcSending] = useState(false)

  const host = conn ? (conn.sub.split(' ')[0].replace('ssh ', '')) : 'jump@db-bastion'
  // 裸主机标识(host/IP),仅用于历史补全的「按主机隔离」匹配——与后端写入 history.target
  // 的口径一致:conn.sub 形如 `user@host:port`,后端 term.rs 写入的 target 即 s.host(裸 host/IP),
  // 取 @ 后、: 前的主机段二者方可相等匹配。不复用于工具栏显示,避免改动既有 UI。
  const matchHost = conn ? hostFromSub(conn.sub) : 'db-bastion'
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

    // Initialise run state for all targets (current session first, then hosts).
    const initial: MxRunState = {}
    if (sessionId && live) {
      initial[sessionId] = { id: sessionId, name: `${conn?.name ?? t('workbench.currentSession')} ·`, state: 'running', out: '' }
    }
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

  // Buffer search via the xterm SearchAddon (highlights + scrolls to matches).
  function doSearch(forward: boolean) {
    const sa = searchAddonRef.current
    if (!sa || !searchQuery) return
    const opts = { caseSensitive: false }
    if (forward) sa.findNext(searchQuery, opts)
    else sa.findPrevious(searchQuery, opts)
  }

  // Send the typed command to every selected broadcast target (+ current session).
  async function sendBroadcast() {
    const cmd = bcCmd.trim()
    if (!cmd || bcSending) return
    setBcSending(true)
    try { await broadcastCommandRef.current(cmd) } finally { setBcSending(false) }
    setBcCmd('')
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
      fontFamily: monoFontStack(prefs.monoFont),
      fontSize: prefs.termFontPx,
      cursorBlink: true,
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    searchAddonRef.current = searchAddon
    try { term.loadAddon(searchAddon) } catch { /* mocked terminal in tests */ }
    term.open(hostEl)
    try { fitAddon.fit() } catch { /* jsdom has no layout */ }

    // ---- 历史补全:输入捕获 + 候选 ----
    // 节流计时器(~40ms),onData 触发提取时合并。
    let extractTimer: ReturnType<typeof setTimeout> | null = null

    // 清掉输入标记并隐藏候选(execStart / closed / 失活时调用)。
    const clearInputCapture = () => {
      try { inputMarkerRef.current?.marker?.dispose() } catch { /* best-effort */ }
      inputMarkerRef.current = null
      currentInputRef.current = ''
      suppressedInputRef.current = null
      setSuggest(null)
      setGhost(null)
    }

    // 在「输入起点」处记录 marker + 列。OSC 633;B 命中后调用。
    const beginInputCapture = () => {
      try {
        const buf = term.buffer.active
        const startCol = typeof buf.cursorX === 'number' ? buf.cursorX : 0
        // registerMarker(0) 锚定当前光标行;测试里 xterm 是 mock,做存在性保护。
        const marker = typeof term.registerMarker === 'function' ? term.registerMarker(0) : null
        inputMarkerRef.current = { marker, startCol }
        suppressedInputRef.current = null
      } catch { inputMarkerRef.current = null }
    }

    // 从 marker 行/startCol 提取到光标行/cursorX 的可见文本,即「当前输入」。
    const readCurrentInput = (): string | null => {
      const cap = inputMarkerRef.current
      if (!cap) return null
      try {
        const buf = term.buffer.active
        const marker = cap.marker
        // marker 失效(被回收)→ 放弃。
        if (marker && (marker as { isDisposed?: boolean }).isDisposed) return null
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

    // 计算候选下拉的绝对坐标(相对 rootRef)+ 上方/下方翻转。
    const computeSuggestPos = (): { left: number; top: number; flipUp: boolean } | null => {
      const root = rootRef.current
      if (!root || !hostEl) return null
      try {
        const rootRect = root.getBoundingClientRect()
        const hostRect = hostEl.getBoundingClientRect()
        const scale = (rootRect.width / root.offsetWidth) || 1
        const buf = term.buffer.active
        const cellW = hostEl.clientWidth / term.cols
        const cellH = hostEl.clientHeight / term.rows
        const rowInView = Math.max(0, (buf.cursorY ?? 0))
        const cursorPxX = (buf.cursorX ?? 0) * cellW
        const left = (hostRect.left + cursorPxX - rootRect.left) / scale
        // 候选默认在光标行下方一行;若离底部太近则翻到上方。
        const belowTopPx = (rowInView + 1) * cellH
        const flipUp = belowTopPx + 200 > hostEl.clientHeight
        const anchorPx = flipUp ? rowInView * cellH : belowTopPx
        const top = (hostRect.top + anchorPx - rootRect.top) / scale
        return { left: Math.max(left, 0), top, flipUp }
      } catch { return null }
    }

    // Phase 2:计算「幽灵文本」浮层的像素坐标 + 是否安全可渲染。
    // 仅当 ghost 非空、输入为单行、且补全后不会越过行尾换行时才返回坐标;
    // 否则返回 null(只保留下拉,避免错位)。坐标与 selection toolbar 同口径
    // (cellW=clientWidth/cols),以等宽 cell 估算光标像素位置。
    const computeGhostPos = (ghostText: string, input: string): { left: number; top: number } | null => {
      if (!ghostText) return null
      // 多行输入:输入里含换行 → 不渲染 ghost。
      if (input.includes('\n')) return null
      const root = rootRef.current
      if (!root || !hostEl) return null
      try {
        const rootRect = root.getBoundingClientRect()
        const hostRect = hostEl.getBoundingClientRect()
        const scale = (rootRect.width / root.offsetWidth) || 1
        const buf = term.buffer.active
        const cellW = hostEl.clientWidth / term.cols
        const cellH = hostEl.clientHeight / term.rows
        const cursorX = buf.cursorX ?? 0
        // 接近行尾:补全后会越过 cols 触发换行 → 不渲染 ghost(避免错位)。
        if (cursorX + ghostText.length > term.cols) return null
        const rowInView = Math.max(0, (buf.cursorY ?? 0))
        const cursorPxX = cursorX * cellW
        const cursorPxY = rowInView * cellH
        const left = (hostRect.left + cursorPxX - rootRect.left) / scale
        const top = (hostRect.top + cursorPxY - rootRect.top) / scale
        return { left, top }
      } catch { return null }
    }

    // 提取当前输入 → planHistoryCompletion → 更新候选 state(+ Phase 2 ghost 浮层)。
    const refreshSuggest = () => {
      if (!(live && sessionId)) { setSuggest(null); setGhost(null); return }
      const input = readCurrentInput()
      if (input == null) { clearInputCapture(); return }
      currentInputRef.current = input
      // Esc 忽略本次输入,直到输入文本变化才恢复。
      if (suppressedInputRef.current != null && suppressedInputRef.current === input) { setSuggest(null); setGhost(null); return }
      if (suppressedInputRef.current != null && suppressedInputRef.current !== input) suppressedInputRef.current = null
      if (!input) { setSuggest(null); setGhost(null); return }
      const entries = loadShellHistory(matchHost, conn)
      const { items, ghost: ghostSuffix } = planHistoryCompletion(input, entries)
      if (!items.length) { setSuggest(null); setGhost(null); return }
      const pos = computeSuggestPos()
      if (!pos) { setSuggest(null); setGhost(null); return }
      setSuggest({ items, left: pos.left, top: pos.top, flipUp: pos.flipUp, input })
      setSuggestIndex(0)
      // Phase 2:engine 已给出 ghost 后缀(仅严格前缀命中时非空)。
      const gpos = ghostSuffix ? computeGhostPos(ghostSuffix, input) : null
      setGhost(gpos ? { text: ghostSuffix as string, left: gpos.left, top: gpos.top } : null)
    }

    // 把字符写入 PTY(补全用)。沿用 onData 的 base64 编码路径。
    const termWrite0 = (s: string) => {
      if (live && sessionId && chanIdRef.current) termWrite(sessionId, chanIdRef.current, bytesToBase64(s))
    }

    // attachCustomKeyEventHandler:候选可见时拦截 ↑/↓/Enter/Tab/Esc(在抵达 PTY 前)。
    // 测试里 xterm mock 没有这个方法 → 存在性保护。
    if (typeof term.attachCustomKeyEventHandler === 'function') {
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true
        // Phase 2:幽灵文本可见时,→ 或 Ctrl+E 接受 ghost 串(写入 PTY 并吞键)。
        const gh = ghostRef.current
        if (gh && gh.text && (ev.key === 'ArrowRight' || (ev.ctrlKey && (ev.key === 'e' || ev.key === 'E')))) {
          termWrite0(gh.text)
          setGhost(null)
          setSuggest(null)
          return false
        }
        const sg = suggestRef.current
        if (!sg || !sg.items.length) return true // 候选不可见时一律放行
        const idx = suggestIndexRef.current
        switch (ev.key) {
          case 'ArrowUp':
            setSuggestIndex(i => (i - 1 + sg.items.length) % sg.items.length)
            return false
          case 'ArrowDown':
            setSuggestIndex(i => (i + 1) % sg.items.length)
            return false
          case 'Enter':
          case 'Tab': {
            // 只补全不执行:写入「选中项相对当前输入的剩余差额」。
            const sel = sg.items[idx]
            const input = currentInputRef.current
            if (sel && sel.text.startsWith(input)) {
              const tail = sel.text.slice(input.length)
              if (tail) termWrite0(tail)
            } else if (sel) {
              // 非前缀命中:无法安全 diff,直接忽略键(关闭候选)。
            }
            setSuggest(null)
            setGhost(null)
            return false
          }
          case 'Escape':
            // 忽略本次输入,直到输入再次变化。
            suppressedInputRef.current = currentInputRef.current
            setSuggest(null)
            setGhost(null)
            return false
          default:
            return true
        }
      })
    }

    // Selection toolbar (copy / ask AI) — driven by xterm's own selection.
    term.onSelectionChange(() => {
      const text = term.getSelection()
      if (!text || !text.trim() || !rootRef.current || !hostEl) { setSelBar(null); return }
      const root = rootRef.current
      const rootRect = root.getBoundingClientRect()
      const hostRect = hostEl.getBoundingClientRect()
      const scale = (rootRect.width / root.offsetWidth) || 1
      const pos = term.getSelectionPosition()
      if (!pos) {
        // No selection position available — fall back to top-anchored toolbar.
        const left = (hostRect.left + hostRect.width / 2 - rootRect.left) / scale
        const top = (hostRect.top + 24 - rootRect.top) / scale
        setSelBar({ left, top, text: text.trim() })
        return
      }
      // Derive cell size from the xterm container (close enough for placement).
      const cellW = hostEl.clientWidth / term.cols
      const cellH = hostEl.clientHeight / term.rows
      // Visible row of the selection start (clamp if scrolled above the viewport).
      const viewportY = term.buffer.active.viewportY
      const rowInView = Math.max(0, pos.start.y - viewportY)
      // Horizontal center of the selection on its start row; top of that row.
      const selLeftPx = ((pos.start.x + pos.end.x) / 2) * cellW
      const selTopPx = rowInView * cellH
      const left = (hostRect.left + selLeftPx - rootRect.left) / scale
      // The toolbar sits ABOVE the selection (JSX uses translateY(-100%)); clamp so
      // it doesn't get clipped off the top of the surface.
      const top = Math.max((hostRect.top + selTopPx - rootRect.top) / scale, 24)
      setSelBar({ left, top, text: text.trim() })
    })

    if (live && sessionId) {
      // Expose this session's buffer to the Catio Agent (read-terminal-buffer pref).
      registerTermBuffer(sessionId, () => dumpTermBuffer(term))
      // ---- LIVE: wire to term_* IPC ----
      ;(async () => {
        const openedChanId = await termOpen(sessionId, term.cols, term.rows)
        chanIdRef.current = openedChanId
        if (disposed) { termClose(sessionId, openedChanId); chanIdRef.current = null; return }
        onChannelRef.current?.(sessionId, openedChanId)
        unlisten = await listen<TermEvent>(`term://${openedChanId}`, (p) => {
          if (typeof p.bytesBase64 === 'string') {
            // 同帧可能携带 inputStart(此时这些字节即提示符本身)。先 write 提示符,
            // 在 write 回调里(光标已落到输入起点)再捕获 marker。
            if (p.inputStart) {
              term.write(base64ToBytes(p.bytesBase64), () => beginInputCapture())
            } else {
              term.write(base64ToBytes(p.bytesBase64))
            }
          } else if (p.inputStart) {
            // 单发的 inputStart 帧(无字节):直接捕获。
            beginInputCapture()
          } else if (p.execStart) {
            // 命令已提交开始执行:清标记 + 隐藏候选。
            clearInputCapture()
          } else if (p.closed) {
            // Server-initiated close: write notice, close channel, then mark it dead so
            // keystrokes and unmount cleanup don't call termClose on a dead channel.
            clearInputCapture()
            term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n')
            if (chanIdRef.current) { termClose(sessionId, chanIdRef.current); chanIdRef.current = null }
            onChannelRef.current?.(sessionId, null)
          }
        })
        if (disposed) { unlisten(); if (chanIdRef.current) { termClose(sessionId, chanIdRef.current); chanIdRef.current = null } return }
        term.onData(d => {
          // Drop keystrokes after a server-initiated close (channel already torn down).
          if (!chanIdRef.current) return
          termWrite(sessionId, chanIdRef.current, bytesToBase64(d))
          // 节流(~40ms)提取当前输入并刷新候选。延迟一拍,让 PTY 回显落到缓冲区。
          if (inputMarkerRef.current) {
            if (extractTimer) clearTimeout(extractTimer)
            extractTimer = setTimeout(() => { extractTimer = null; refreshSuggest() }, 40)
          }
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
      if (extractTimer) clearTimeout(extractTimer)
      try { inputMarkerRef.current?.marker?.dispose() } catch { /* best-effort */ }
      inputMarkerRef.current = null
      if (ro) ro.disconnect()
      if (unlisten) unlisten()
      // Only call termClose if the channel is still live (not already closed by server).
      if (live && sessionId && chanIdRef.current) { termClose(sessionId, chanIdRef.current); chanIdRef.current = null }
      if (live && sessionId) { onChannelRef.current?.(sessionId, null); unregisterTermBuffer(sessionId) }
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
    // re-init when the session/chan identity changes
  }, [sessionId, live, conn])

  // Live-apply terminal font prefs WITHOUT recreating the terminal (which would
  // drop the scrollback). Update xterm options, refit, and push the new size to
  // the live PTY so the remote `$COLUMNS/$LINES` stay correct.
  useEffect(() => {
    const term = termRef.current
    if (!term || !term.options) return
    term.options.fontSize = prefs.termFontPx
    term.options.fontFamily = monoFontStack(prefs.monoFont)
    try { fitAddonRef.current?.fit() } catch { /* no layout */ }
    if (live && sessionId && chanIdRef.current) {
      try { termResize(sessionId, chanIdRef.current, term.cols, term.rows) } catch { /* best-effort */ }
    }
  }, [prefs.termFontPx, prefs.monoFont, live, sessionId])

  // ---- Snippet / history / AI "insert" + "run" into the live PTY ----
  // Only the ACTIVE pane handles these window events so the command goes to the
  // focused terminal (panes stay mounted while hidden). `catio-insert` writes the
  // text into the PTY without executing; `catio-run` writes it then sends a
  // carriage-return (\r) — exactly what pressing Enter does — so it executes.
  useEffect(() => {
    if (!active) return
    const writeToPty = (text: string) => {
      if (!live || !sessionId) return false
      const chanId = chanIdRef.current
      if (!chanId) return false
      termWrite(sessionId, chanId, bytesToBase64(text))
      try { termRef.current?.focus() } catch { /* best-effort */ }
      return true
    }
    const onInsert = (e: Event) => {
      const ce = e as CustomEvent<{ kind?: string; text?: string }>
      if (!ce.detail || ce.detail.kind !== 'shell' || typeof ce.detail.text !== 'string') return
      writeToPty(ce.detail.text)
    }
    const onRun = (e: Event) => {
      const ce = e as CustomEvent<{ kind?: string; text?: string }>
      if (!ce.detail || ce.detail.kind !== 'shell' || typeof ce.detail.text !== 'string') return
      // Insert the command, then send \r so the PTY executes it (same as Enter).
      if (writeToPty(ce.detail.text)) writeToPty('\r')
    }
    window.addEventListener('catio-insert', onInsert)
    window.addEventListener('catio-run', onRun)
    return () => {
      window.removeEventListener('catio-insert', onInsert)
      window.removeEventListener('catio-run', onRun)
    }
  }, [active, live, sessionId])

  // When this pane becomes the shown tab, its container regained a real size.
  // Refit xterm to the now-laid-out container, push the new size to the live PTY,
  // and focus so typing goes straight to the terminal.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitAddonRef.current
    if (!term) return
    // Defer to next frame so the display:none→flex layout has settled.
    const id = requestAnimationFrame(() => {
      try { fit?.fit() } catch { /* no layout (e.g. jsdom) */ }
      if (live && sessionId && chanIdRef.current) {
        try { termResize(sessionId, chanIdRef.current, term.cols, term.rows) } catch { /* best-effort */ }
      }
      try { term.focus() } catch { /* best-effort */ }
    })
    return () => cancelAnimationFrame(id)
  }, [active, live, sessionId])

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
    <div ref={rootRef} className="col" style={{ height: '100%', minHeight: 0, flex: 1, width: '100%', minWidth: 0, overflow: 'hidden', position: 'relative' }}>
      {/* term toolbar */}
      <div className="row" style={{ justifyContent: 'space-between', padding: '7px 12px', borderBottom: '1px solid var(--border-hairline)', minWidth: 0, gap: 10 }}>
        <div className="row gap8" style={{ minWidth: 0, overflow: 'hidden' }}>
          <ConnGlyph conn={displayConn} size={26} radius={7} />
          <div className="col" style={{ lineHeight: 1.2 }}>
            <span className="row gap6" style={{ fontSize: 13, fontWeight: 600 }}>{conn ? conn.name : 'db-bastion'} <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 400 }}>ssh-ed25519</span></span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{host} · xterm-256color</span>
          </div>
          <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 13%, transparent)', color: 'var(--signal-green)' }}><span className="dot" style={{ background: 'var(--signal-green)' }} /> connected</span>
        </div>
        <div className="row gap6" style={{ flex: 'none' }}>
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
          <button className="icon-btn bare" title={t('workbench.searchBuffer')} onClick={() => setSearchOpen(o => !o)}
            style={{ color: searchOpen ? 'var(--accent-primary)' : undefined, background: searchOpen ? 'var(--accent-soft)' : undefined }}><Icon name="search" size={15} /></button>
          <button className="icon-btn bare" title={t('workbench.clearScreen')} onClick={() => { if (termRef.current) termRef.current.clear() }}><Icon name="broom" size={15} /></button>
        </div>
      </div>

      {/* Multi-Exec broadcast bar — type a command, run it on every selected host */}
      {broadcast && (
        <div className="row gap8" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', flex: 'none', alignItems: 'center' }}>
          <Icon name="radar" size={14} style={{ color: 'var(--accent-primary)', flex: 'none' }} />
          <input value={bcCmd} onChange={e => setBcCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void sendBroadcast() }}
            placeholder={t('workbench.broadcastCmdPlaceholder', { count: mxHosts.length + 1 })}
            className="mono" style={{ flex: 1, height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-card)', fontSize: 12.5, color: 'var(--text-primary)', outline: 'none' }} />
          <button className="btn btn-primary sm" style={{ flex: 'none' }} disabled={!bcCmd.trim() || bcSending} onClick={() => void sendBroadcast()}>
            <Icon name="radar" size={13} /> {t('workbench.broadcastSend', { count: mxHosts.length + 1 })}
          </button>
        </div>
      )}

      {/* Multi-Exec per-target results */}
      {Object.keys(mxRunState).length > 0 && (
        <div className="col" style={{ maxHeight: 190, overflowY: 'auto', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', flex: 'none' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '5px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('workbench.broadcastResults')}</span>
            <button className="icon-btn bare" title={t('workbench.clearAll')} style={{ width: 18, height: 18 }} onClick={() => setMxRunState({})}><Icon name="x" size={12} /></button>
          </div>
          {Object.values(mxRunState).map(tg => (
            <div key={tg.id} className="col" style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 3 }}>
              <div className="row gap6" style={{ alignItems: 'center' }}>
                <span className="dot" style={{ background: tg.state === 'done' ? 'var(--signal-green)' : tg.state === 'error' ? 'var(--danger-fg)' : 'var(--signal-amber)' }} />
                <span className="ell" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>{tg.name}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{tg.state}</span>
              </div>
              {tg.out && <pre className="mono" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 90, overflow: 'auto' }}>{tg.out}</pre>}
            </div>
          ))}
        </div>
      )}

      {/* terminal surface — xterm.js host */}
      <div ref={xtermHost} className="grow" onMouseDown={() => setSelBar(null)}
        style={{ overflow: 'hidden', background: 'var(--term-bg)', padding: '12px 14px', fontFamily: monoFontStack(prefs.monoFont), fontSize: prefs.termFontPx, lineHeight: 1.65, minHeight: 0 }} />

      {/* 历史补全候选下拉(仅 live + 输入激活 + 有匹配时显示) */}
      {live && suggest && (
        <HistorySuggest
          items={suggest.items}
          selectedIndex={suggestIndex}
          left={suggest.left}
          top={suggest.top}
          flipUp={suggest.flipUp}
          input={suggest.input}
          onPick={(i) => {
            const sel = suggest.items[i]
            const input = currentInputRef.current
            if (sel && sel.text.startsWith(input) && sessionId && chanIdRef.current) {
              const tail = sel.text.slice(input.length)
              if (tail) termWrite(sessionId, chanIdRef.current, bytesToBase64(tail))
            }
            setSuggest(null)
            setGhost(null)
            try { termRef.current?.focus() } catch { /* best-effort */ }
          }}
        />
      )}

      {/* Phase 2:行内灰色「幽灵文本」浮层 —— 纯视觉叠加,绝不写入终端。
          字体/字号跟随终端(prefs.monoFont/termFontPx)+ lineHeight 与 xterm host 同口径,
          颜色用 var(--text-faint) 跟随主题。仅 live + ghost 可见时渲染。 */}
      {live && ghost && (
        <span
          aria-hidden
          className="mono"
          style={{
            position: 'absolute',
            left: ghost.left,
            top: ghost.top,
            zIndex: 24,
            pointerEvents: 'none',
            fontFamily: monoFontStack(prefs.monoFont),
            fontSize: prefs.termFontPx,
            lineHeight: 1.65,
            color: 'var(--text-faint)',
            opacity: 0.6,
            whiteSpace: 'pre',
            userSelect: 'none',
          }}
        >
          {ghost.text}
        </span>
      )}

      {/* buffer search overlay (xterm SearchAddon) */}
      {searchOpen && (
        <div className="row gap4 pop-in" style={{ position: 'absolute', top: 54, right: 14, zIndex: 30, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 9, boxShadow: 'var(--shadow-dropdown)', padding: '4px 6px', alignItems: 'center' }}>
          <Icon name="search" size={13} style={{ color: 'var(--text-faint)', flex: 'none' }} />
          <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doSearch(!e.shiftKey); if (e.key === 'Escape') setSearchOpen(false) }}
            placeholder={t('workbench.searchBuffer')}
            className="mono" style={{ width: 170, height: 26, border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, color: 'var(--text-primary)' }} />
          <button className="icon-btn bare" title={t('workbench.searchPrev')} style={{ width: 22, height: 22, flex: 'none' }} onClick={() => doSearch(false)}><Icon name="chevron-up" size={13} /></button>
          <button className="icon-btn bare" title={t('workbench.searchNext')} style={{ width: 22, height: 22, flex: 'none' }} onClick={() => doSearch(true)}><Icon name="chevron-down" size={13} /></button>
          <button className="icon-btn bare" style={{ width: 22, height: 22, flex: 'none' }} onClick={() => setSearchOpen(false)}><Icon name="x" size={13} /></button>
        </div>
      )}

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
            <Icon name="wand" size={13} /> {t('workbench.askAI')}
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
