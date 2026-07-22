/* Split-view container for SSH terminals. Holds a binary tiling tree (see terminalLayout):
 * splitting one pane only subdivides that pane's area, so e.g. splitting the right pane of a
 * left/right layout into top/bottom leaves the left pane untouched. Leaves are rendered as a
 * FLAT, stably-keyed list positioned absolutely from the computed tree — splitting / closing /
 * swapping never reparents a leaf, so each TerminalPane (and its live PTY session) is
 * preserved. The split / drag controls live in each pane's own toolbar; the focused pane gets
 * an accent outline and its channel is reported up to App (so snippet/history/AI "insert"
 * targets the focused terminal). */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { TerminalPane } from './TerminalPane'
import { splitLeaf, closeLeaf, swapLeaves, collectLeaves, computeRects, type PaneNode } from './terminalLayout'
import type { Connection } from '../../services/types'
import { notifyAgentTerminalSplitReady, onAgentTerminalSplitCancel, onAgentTerminalSplitRequest } from '../../services/agentTerminalSplit'

export interface SplitTerminalProps {
  tabId?: string
  conn: Connection | null
  sessionId?: string
  active?: boolean
  connected?: boolean
  resolveSessionId?: (connId: string) => string | undefined
  mxCandidates?: Connection[]
  ensureSession?: (connId: string) => Promise<string | 'needs-auth' | 'failed'>
  onConnectTarget?: (connId: string) => void
  sendToPty?: (sessionId: string, cmd: string) => Promise<boolean>
  onSessionClosed?: (sessionId: string) => void
  onReconnect?: () => Promise<boolean> | boolean | void
  /** Reports the FOCUSED pane's live channel id (null when none). */
  onChannel?: (sessionId: string, chanId: string | null) => void
}

let paneSeq = 0

export function SplitTerminal({ tabId, onChannel, ...paneProps }: SplitTerminalProps) {
  const [root, setRoot] = useState<PaneNode>(() => ({ type: 'leaf', id: `p${paneSeq++}` }))
  const [focused, setFocused] = useState<string>(() => collectLeaves(root)[0])
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [historySuggestEnabled, setHistorySuggestEnabled] = useState(true)
  // Latest channel id per pane (so focus changes can re-report to App).
  const paneChan = useRef<Record<string, string | null>>({})
  const pendingAgentSplits = useRef<Record<string, { requestId: string; originId: string }>>({})
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  const leafIds = useMemo(() => collectLeaves(root), [root])
  const leafIdsRef = useRef(leafIds)
  leafIdsRef.current = leafIds
  const rects = useMemo(() => computeRects(root), [root])
  const multi = leafIds.length > 1

  // Report the focused pane's channel whenever focus changes.
  useEffect(() => {
    onChannel?.(paneProps.sessionId ?? '', paneChan.current[focused] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  function split(id: string, dir: 'row' | 'col'): string {
    const newId = `p${paneSeq++}`
    setRoot(prev => splitLeaf(prev, id, dir, newId))
    setFocused(newId)
    return newId
  }

  useEffect(() => {
    if (!tabId) return
    const stopRequest = onAgentTerminalSplitRequest(tabId, requestId => {
      const newId = `p${paneSeq++}`
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
    if (!next) return // can't close the last pane
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

  // Pointer-based drag (Tauri's webview swallows HTML5 DnD for OS file-drop, so the native
  // drag events never fire). pointerdown on a pane's grip captures the pointer, so pointerup
  // always fires (even released outside the window); the cursor's pane is found via
  // elementFromPoint, and releasing over a different pane swaps them.
  const dragRef = useRef<string | null>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  function startDrag(id: string, e: ReactPointerEvent) {
    if (e.button !== 0) return // left button only
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
    // With pointer capture, these fire on the grip element for the whole gesture.
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }
  // Detach a mid-drag's listeners if the pane unmounts before pointerup.
  useEffect(() => () => dragCleanup.current?.(), [])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', minHeight: 0, background: 'var(--border-hairline)', cursor: dragId ? 'grabbing' : undefined }}>
      {leafIds.map(id => {
        const r = rects.get(id)!
        return (
          <div key={id} data-pane-id={id} onMouseDownCapture={() => setFocused(id)}
            style={{ position: 'absolute', left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%`, padding: multi ? 1 : 0, boxSizing: 'border-box', opacity: dragId === id ? 0.55 : 1 }}>
            <div style={{ height: '100%', width: '100%', minHeight: 0, position: 'relative', background: 'var(--surface-subtle)', outline: multi ? (dropId === id ? '2px dashed var(--accent-primary)' : focused === id ? '2px solid var(--accent-border)' : 'none') : 'none', outlineOffset: '-2px' }}>
              <TerminalPane {...paneProps} isFocused={id === focused}
                historySuggestEnabled={historySuggestEnabled}
                onToggleHistorySuggest={() => setHistorySuggestEnabled(v => !v)}
                onChannel={(sid, chan) => {
                  paneChan.current[id] = chan
                  if (id === focused) onChannel?.(sid, chan)
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
                }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
