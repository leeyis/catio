/* 本地终端的分屏容器。复用 terminalLayout 的二叉平铺树逻辑(与 SSH 的 SplitTerminal
 * 同款),渲染多个 LocalTerminalPane —— 每个 pane 是**独立的本地 shell 会话**(各自 chanId)。
 * 分屏/关闭/拖拽换位只重排布局,不 reparent 叶子,故每个终端的 PTY 会话被保留。
 * 聚焦的 pane 上报其 channel 给 App(供历史「插入」按钮定位),并只由聚焦 pane 分发历史事件。 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { LocalTerminalPane } from './LocalTerminalPane'
import { splitLeaf, closeLeaf, swapLeaves, collectLeaves, computeRects, type PaneNode } from './terminalLayout'
import type { Connection } from '../../services/types'
import type { HistoryEvent } from '../../services/ssh'
import { notifyAgentTerminalSplitReady, onAgentTerminalSplitCancel, onAgentTerminalSplitRequest } from '../../services/agentTerminalSplit'

export interface LocalSplitTerminalProps {
  tabId?: string
  conn: Connection
  active?: boolean
  /** 聚焦 pane 的命令审计回调(仅 local shell 触发)。 */
  onHistory?: (e: HistoryEvent) => void
  /** 聚焦 pane 的 channel 上报(打开传 id,关闭/失焦传 null),App 写入 chanMap。 */
  onChannel?: (chanId: string | null) => void
}

let paneSeq = 0

export function LocalSplitTerminal({ tabId, conn, active, onHistory, onChannel }: LocalSplitTerminalProps) {
  const [root, setRoot] = useState<PaneNode>(() => ({ type: 'leaf', id: `lp${paneSeq++}` }))
  const [focused, setFocused] = useState<string>(() => collectLeaves(root)[0])
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  // 每个 pane 最新的 chanId,焦点切换时可重新上报给 App。
  const paneChan = useRef<Record<string, string | null>>({})
  const pendingAgentSplits = useRef<Record<string, { requestId: string; originId: string }>>({})
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  const leafIds = useMemo(() => collectLeaves(root), [root])
  const leafIdsRef = useRef(leafIds)
  leafIdsRef.current = leafIds
  const rects = useMemo(() => computeRects(root), [root])
  const multi = leafIds.length > 1

  // 焦点变化时,把聚焦 pane 的 channel 上报给 App(历史「插入」定位到聚焦终端)。
  useEffect(() => {
    onChannel?.(paneChan.current[focused] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  function split(id: string, dir: 'row' | 'col'): string {
    const newId = `lp${paneSeq++}`
    setRoot(prev => splitLeaf(prev, id, dir, newId))
    setFocused(newId)
    return newId
  }

  useEffect(() => {
    if (!tabId) return
    const stopRequest = onAgentTerminalSplitRequest(tabId, requestId => {
      const newId = `lp${paneSeq++}`
      const originId = focusedRef.current
      setRoot(prev => splitLeaf(prev, originId, 'row', newId))
      setFocused(newId)
      pendingAgentSplits.current[newId] = { requestId, originId }
    })
    const stopCancel = onAgentTerminalSplitCancel(tabId, requestId => {
      const pending = Object.entries(pendingAgentSplits.current).find(([, value]) => value.requestId === requestId)
      if (!pending) return
      const [paneId, { originId }] = pending
      delete pendingAgentSplits.current[paneId]
      delete paneChan.current[paneId]
      setRoot(prev => closeLeaf(prev, paneId) ?? prev)
      const remaining = leafIdsRef.current.filter(id => id !== paneId)
      setFocused(current => {
        if (current !== paneId && remaining.includes(current)) return current
        return remaining.includes(originId) ? originId : (remaining[0] ?? current)
      })
    })
    return () => { stopRequest(); stopCancel() }
  }, [tabId])
  function close(id: string) {
    const next = closeLeaf(root, id)
    if (!next) return // 最后一个 pane 不能关
    delete pendingAgentSplits.current[id]
    delete paneChan.current[id]
    if (focused === id) {
      const remaining = collectLeaves(next)
      setFocused(remaining[remaining.length - 1])
    }
    setRoot(next)
  }
  function swap(a: string, b: string) {
    if (!a || !b || a === b) return
    setRoot(prev => swapLeaves(prev, a, b))
    setFocused(a)
  }

  // 指针拖拽换位(与 SSH SplitTerminal 同款:Tauri webview 吞掉 HTML5 DnD,故用 pointer capture)。
  const dragRef = useRef<string | null>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  function startDrag(id: string, e: ReactPointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    try { grip.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    dragRef.current = id
    setDragId(id)
    const paneAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      return (el?.closest('[data-pane-id]') as HTMLElement | null)?.getAttribute('data-pane-id') ?? null
    }
    const move = (ev: PointerEvent) => {
      const over = paneAt(ev.clientX, ev.clientY)
      setDropId(over && over !== dragRef.current ? over : null)
    }
    const detach = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      dragCleanup.current = null
    }
    const up = (ev: PointerEvent) => {
      detach()
      const over = paneAt(ev.clientX, ev.clientY)
      if (over && dragRef.current && over !== dragRef.current) swap(dragRef.current, over)
      dragRef.current = null
      setDragId(null)
      setDropId(null)
    }
    dragCleanup.current = detach
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }
  useEffect(() => () => dragCleanup.current?.(), [])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', minHeight: 0, background: 'var(--border-hairline)', cursor: dragId ? 'grabbing' : undefined }}>
      {leafIds.map(id => {
        const r = rects.get(id)!
        return (
          <div key={id} data-pane-id={id} onMouseDownCapture={() => setFocused(id)}
            style={{ position: 'absolute', left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%`, padding: multi ? 1 : 0, boxSizing: 'border-box', opacity: dragId === id ? 0.55 : 1 }}>
            <div style={{ height: '100%', width: '100%', minHeight: 0, position: 'relative', background: 'var(--surface-subtle)', outline: multi ? (dropId === id ? '2px dashed var(--accent-primary)' : focused === id ? '2px solid var(--accent-border)' : 'none') : 'none', outlineOffset: '-2px' }}>
              <LocalTerminalPane
                conn={conn}
                active={active && id === focused}
                onHistory={id === focused ? onHistory : undefined}
                onChannel={chan => {
                  paneChan.current[id] = chan
                  if (id === focused) onChannel?.(chan)
                  const pending = pendingAgentSplits.current[id]
                  if (tabId && chan && pending) {
                    delete pendingAgentSplits.current[id]
                    notifyAgentTerminalSplitReady(tabId, pending.requestId, chan)
                  }
                }}
                split={{
                  count: leafIds.length,
                  onSplitRight: () => split(id, 'row'),
                  onSplitDown: () => split(id, 'col'),
                  onClose: () => close(id),
                  onDragStart: (e) => startDrag(id, e),
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
