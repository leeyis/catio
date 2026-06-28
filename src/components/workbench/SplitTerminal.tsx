/* Split-view container for SSH terminals. Renders one or more TerminalPane panes
 * sharing the same SSH session (each opens its own PTY channel). Panes are laid out
 * in a single row or column; the focused pane gets an accent outline and its channel
 * is reported up to App (so snippet/history "insert" targets the focused terminal). */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
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
  const { t } = useTranslation()
  const [panes, setPanes] = useState<string[]>(() => [`p${paneSeq++}`])
  const [orientation, setOrientation] = useState<'row' | 'col'>('row')
  const [focused, setFocused] = useState<string>(() => panes[0])
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

  const multi = panes.length > 1

  return (
    <div className="col" style={{ height: '100%', width: '100%', minHeight: 0 }}>
      {/* split controls */}
      <div className="row" style={{ flex: 'none', gap: 4, alignItems: 'center', padding: '3px 8px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-card)' }}>
        <IconBtn name="columns" size={14} variant="bare" title={t('split.splitRight')} onClick={() => splitInto('row')} />
        <IconBtn name="rows" size={14} variant="bare" title={t('split.splitDown')} onClick={() => splitInto('col')} />
        {multi && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('split.count', { n: panes.length })}</span>}
      </div>
      <div className="row" style={{ flex: 1, minHeight: 0, flexDirection: orientation === 'row' ? 'row' : 'column', gap: multi ? 1 : 0, background: 'var(--border-hairline)' }}>
        {panes.map(id => (
          <div key={id} onMouseDownCapture={() => setFocused(id)}
            style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', background: 'var(--surface-subtle)', outline: multi && focused === id ? '2px solid var(--accent-border)' : 'none', outlineOffset: '-2px' }}>
            <TerminalPane {...paneProps} isFocused={id === focused}
              onChannel={(sid, chan) => { paneChan.current[id] = chan; if (id === focused) onChannel?.(sid, chan) }} />
            {multi && (
              <button className="icon-btn bare" title={t('split.closePane')} onClick={() => closePane(id)}
                style={{ position: 'absolute', top: 6, right: 8, zIndex: 6, width: 20, height: 20, background: 'var(--surface-card)', borderRadius: 6 }}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
