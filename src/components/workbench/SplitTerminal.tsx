/* Split-view container for SSH terminals. Holds a binary tiling tree (see terminalLayout):
 * splitting one pane only subdivides that pane's area, so e.g. splitting the right pane of a
 * left/right layout into top/bottom leaves the left pane untouched. Leaves are rendered as a
 * FLAT, stably-keyed list positioned absolutely from the computed tree — splitting / closing /
 * swapping never reparents a leaf, so each TerminalPane (and its live PTY session) is
 * preserved. The split / drag controls live in each pane's own toolbar; the focused pane gets
 * an accent outline and its channel is reported up to App (so snippet/history/AI "insert"
 * targets the focused terminal). */
import { useEffect, useMemo, useRef, useState } from 'react'
import { TerminalPane } from './TerminalPane'
import { splitLeaf, closeLeaf, swapLeaves, collectLeaves, computeRects, type PaneNode } from './terminalLayout'
import type { Connection } from '../../services/types'

export interface SplitTerminalProps {
  conn: Connection | null
  sessionId?: string
  active?: boolean
  resolveSessionId?: (connId: string) => string | undefined
  mxCandidates?: Connection[]
  ensureSession?: (connId: string) => Promise<string | 'needs-auth' | 'failed'>
  onConnectTarget?: (connId: string) => void
  sendToPty?: (sessionId: string, cmd: string) => Promise<boolean>
  /** Reports the FOCUSED pane's live channel id (null when none). */
  onChannel?: (sessionId: string, chanId: string | null) => void
}

let paneSeq = 0

export function SplitTerminal({ onChannel, ...paneProps }: SplitTerminalProps) {
  const [root, setRoot] = useState<PaneNode>(() => ({ type: 'leaf', id: `p${paneSeq++}` }))
  const [focused, setFocused] = useState<string>(() => collectLeaves(root)[0])
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  // Latest channel id per pane (so focus changes can re-report to App).
  const paneChan = useRef<Record<string, string | null>>({})

  const leafIds = useMemo(() => collectLeaves(root), [root])
  const rects = useMemo(() => computeRects(root), [root])
  const multi = leafIds.length > 1

  // Report the focused pane's channel whenever focus changes.
  useEffect(() => {
    onChannel?.(paneProps.sessionId ?? '', paneChan.current[focused] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  function split(id: string, dir: 'row' | 'col') {
    const newId = `p${paneSeq++}`
    setRoot(prev => splitLeaf(prev, id, dir, newId))
    setFocused(newId)
  }
  function close(id: string) {
    const next = closeLeaf(root, id)
    if (!next) return // can't close the last pane
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

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', minHeight: 0, background: 'var(--border-hairline)' }}>
      {leafIds.map(id => {
        const r = rects.get(id)!
        return (
          <div key={id} onMouseDownCapture={() => setFocused(id)}
            onDragOver={e => { if (dragId && dragId !== id) { e.preventDefault(); if (dropId !== id) setDropId(id) } }}
            onDragLeave={() => { if (dropId === id) setDropId(null) }}
            onDrop={e => { e.preventDefault(); if (dragId) swap(dragId, id); setDragId(null); setDropId(null) }}
            style={{ position: 'absolute', left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%`, padding: multi ? 1 : 0, boxSizing: 'border-box' }}>
            <div style={{ height: '100%', width: '100%', minHeight: 0, position: 'relative', background: 'var(--surface-subtle)', outline: multi ? (dropId === id ? '2px dashed var(--accent-primary)' : focused === id ? '2px solid var(--accent-border)' : 'none') : 'none', outlineOffset: '-2px' }}>
              <TerminalPane {...paneProps} isFocused={id === focused}
                onChannel={(sid, chan) => { paneChan.current[id] = chan; if (id === focused) onChannel?.(sid, chan) }}
                split={{
                  count: leafIds.length,
                  onSplitRight: () => split(id, 'row'),
                  onSplitDown: () => split(id, 'col'),
                  onClose: () => close(id),
                  onDragStart: () => setDragId(id),
                  onDragEnd: () => { setDragId(null); setDropId(null) },
                }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
