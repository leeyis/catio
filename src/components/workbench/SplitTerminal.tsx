/* Split-view container for SSH terminals. Renders one or more TerminalPane panes sharing
 * the same SSH session (each opens its own PTY channel). With a single pane it is a thin
 * pass-through that fills the area (no extra chrome). The split / drag controls live inside
 * each pane's own toolbar (after the clear-screen button). Panes lay out in a row or column,
 * each flex:1 so they always tile evenly; a drag handle lets the user reorder them. The
 * focused pane gets an accent outline and its channel is reported up to App (so
 * snippet/history/AI "insert" targets the focused terminal). */
import { useEffect, useRef, useState } from 'react'
import { TerminalPane } from './TerminalPane'
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
  const [panes, setPanes] = useState<string[]>(() => [`p${paneSeq++}`])
  const [orientation, setOrientation] = useState<'row' | 'col'>('row')
  const [focused, setFocused] = useState<string>(() => panes[0])
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  // Latest channel id per pane (so focus changes can re-report to App).
  const paneChan = useRef<Record<string, string | null>>({})

  // Report the focused pane's channel whenever focus changes.
  useEffect(() => {
    onChannel?.(paneProps.sessionId ?? '', paneChan.current[focused] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  function splitInto(o: 'row' | 'col') {
    setOrientation(o)
    const id = `p${paneSeq++}`
    setPanes(prev => [...prev, id])
    setFocused(id)
  }
  function closePane(id: string) {
    if (panes.length <= 1) return
    const next = panes.filter(p => p !== id)
    setPanes(next)
    delete paneChan.current[id]
    if (focused === id) setFocused(next[next.length - 1])
  }
  function reorder(from: string, to: string) {
    if (!from || from === to) return
    setPanes(prev => {
      const arr = [...prev]
      const fi = arr.indexOf(from), ti = arr.indexOf(to)
      if (fi < 0 || ti < 0) return prev
      arr.splice(fi, 1)
      // After removing `from`, indices past it shift left by one — drop into the target's slot.
      arr.splice(fi < ti ? ti - 1 : ti, 0, from)
      return arr
    })
    setFocused(from)
  }

  const multi = panes.length > 1

  return (
    <div className="row" style={{ height: '100%', width: '100%', minHeight: 0, alignItems: 'stretch', flexDirection: orientation === 'row' ? 'row' : 'column', gap: multi ? 2 : 0, background: 'var(--border-hairline)' }}>
      {panes.map(id => (
        <div key={id} onMouseDownCapture={() => setFocused(id)}
          onDragOver={e => { if (dragId && dragId !== id) { e.preventDefault(); if (dropId !== id) setDropId(id) } }}
          onDragLeave={() => { if (dropId === id) setDropId(null) }}
          onDrop={e => { e.preventDefault(); if (dragId) reorder(dragId, id); setDragId(null); setDropId(null) }}
          style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', background: 'var(--surface-subtle)', outline: multi ? (dropId === id ? '2px dashed var(--accent-primary)' : focused === id ? '2px solid var(--accent-border)' : 'none') : 'none', outlineOffset: '-2px' }}>
          <TerminalPane {...paneProps} isFocused={id === focused}
            onChannel={(sid, chan) => { paneChan.current[id] = chan; if (id === focused) onChannel?.(sid, chan) }}
            split={{
              count: panes.length,
              onSplitRight: () => splitInto('row'),
              onSplitDown: () => splitInto('col'),
              onClose: () => closePane(id),
              onDragStart: () => setDragId(id),
              onDragEnd: () => { setDragId(null); setDropId(null) },
            }} />
        </div>
      ))}
    </div>
  )
}
