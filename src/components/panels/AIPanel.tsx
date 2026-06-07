/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import { highlightSQL } from '../dbviews'
import { useData } from '../../state/DataContext'
import type { Connection, ChatMessage, AgentSnippet } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface Attachment {
  kind: 'sql' | 'shell'
  target: string
  text: string
}

export interface AIPanelProps {
  onClose: () => void
  mode?: 'sql' | 'shell'
  conn?: Connection
  attachment: Attachment | null
  onClearAttachment: () => void
}

function mdBold(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\*\*([^*]+)\*\*/g, '<b style="color:var(--text-primary)">$1</b>')
}

function shellHL(code: string): string {
  let h = code.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  h = h.replace(/('[^']*')/g, '<span style="color:var(--signal-green)">$1</span>')
  h = h.replace(/\b(\d[\d.]*)\b/g, '<span style="color:var(--signal-amber)">$1</span>')
  return h
}

interface SnippetCardProps {
  snippet: AgentSnippet & { preRan?: boolean }
}

function SnippetCard({ snippet }: SnippetCardProps) {
  const { t } = useTranslation()
  const isSql = snippet.kind === 'sql'
  const tone = isSql ? 'var(--signal-blue)' : 'var(--signal-amber)'
  const [inserted, setInserted] = useState(false)
  const [phase, setPhase] = useState(snippet.preRan ? 'done' : 'idle') // idle | running | done
  function doInsert() { setInserted(true); setTimeout(() => setInserted(false), 1800) }
  function doExec() { setPhase('running'); setTimeout(() => setPhase('done'), 520) }
  return (
    <div className="col" style={{ border: '1px solid var(--border-hairline)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-card)' }}>
      {/* header: scope + action, then insert/execute icons */}
      <div className="row gap6" style={{ padding: '6px 8px 6px 10px', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-hairline)' }}>
        <span className="dot" style={{ background: tone }} />
        <Icon name={isSql ? 'database' : 'terminal'} size={12} style={{ color: tone }} />
        <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{isSql ? 'SQL' : 'SHELL'}</span>
        {snippet.action && <span className="badge-accent" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}>{snippet.action}</span>}
        <div className="grow" />
        <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={isSql ? t('panels.insertSqlEditor') : t('panels.insertTerminal')} onClick={doInsert}>
          <Icon name="arrow-right-to-line" size={14} />
        </button>
        <button className="icon-btn" style={{ width: 24, height: 24, background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }} title={isSql ? t('panels.execQuery') : t('panels.execCommand')} onClick={doExec}>
          <Icon name={phase === 'running' ? 'loader' : 'play'} size={13} style={phase === 'running' ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
      </div>
      {/* code */}
      <pre className="mono" style={{ margin: 0, padding: '9px 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', background: 'var(--surface-subtle)', overflowX: 'auto' }}
        dangerouslySetInnerHTML={{ __html: isSql ? highlightSQL(snippet.code) : shellHL(snippet.code) }} />
      {/* inserted toast */}
      {inserted && (
        <div className="row gap6 fade-in" style={{ padding: '6px 10px', borderTop: '1px solid var(--border-hairline)', background: 'var(--accent-soft-alt)', color: 'var(--accent-primary)', fontSize: 11.5, fontWeight: 500 }}>
          <Icon name="check" size={12} /> {isSql ? t('panels.insertedSqlEditor') : t('panels.insertedTerminal')}
        </div>
      )}
      {/* execution result */}
      {phase === 'running' && (
        <div className="row gap6" style={{ padding: '7px 10px', borderTop: '1px solid var(--border-hairline)', color: 'var(--text-tertiary)', fontSize: 11.5 }}>
          <Icon name="loader" size={12} style={{ animation: 'spin 1s linear infinite' }} /> {t('panels.executingOn', { target: snippet.target })}
        </div>
      )}
      {phase === 'done' && snippet.result && (
        <div className="row gap6 fade-in" style={{ padding: '7px 10px', borderTop: '1px solid var(--border-hairline)' }}>
          <Icon name="corner-down-right" size={12} style={{ color: 'var(--signal-green)', flex: 'none' }} />
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-primary)', fontWeight: 500 }}>{snippet.result}</span>
        </div>
      )}
    </div>
  )
}

interface AgentMessageProps {
  m: ChatMessage
}

function AgentMessage({ m }: AgentMessageProps) {
  return (
    <div className="col gap8" style={{ maxWidth: '94%' }}>
      {m.text && <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }} dangerouslySetInnerHTML={{ __html: mdBold(m.text) }} />}
      {m.snippet && <SnippetCard snippet={m.snippet} />}
      {(m.steps || []).map((s, i) => <SnippetCard key={i} snippet={{ ...s, action: s.label, preRan: true }} />)}
      {m.text2 && <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }} dangerouslySetInnerHTML={{ __html: mdBold(m.text2) }} />}
    </div>
  )
}

export function AIPanel({ onClose, mode = 'sql', conn, attachment, onClearAttachment }: AIPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const isSql = mode !== 'shell'
  const thread = isSql ? D.aiSql : D.aiShell
  const target = conn ? conn.name : (isSql ? 'prod-orders' : 'prod-web-01')
  const accent = isSql ? 'var(--signal-blue)' : 'var(--signal-amber)'
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (attachment && taRef.current) taRef.current.focus() }, [attachment])
  return (
    <PanelShell icon="sparkles" title="Catio Agent"
      sub={isSql ? t('panels.sqlAssistantSub', { target }) : t('panels.shellAssistantSub', { target })}
      onClose={onClose}
      actions={<IconBtn name="history" size={15} variant="bare" title={t('panels.sessionHistory')} />}>
      {/* scope banner — strictly follows the active workbench tab */}
      <div className="row gap8" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
        <span className="chip" style={{ background: `color-mix(in srgb, ${accent} 15%, transparent)`, color: accent, fontWeight: 600 }}>
          <Icon name={isSql ? 'database' : 'terminal'} size={11} /> {isSql ? t('panels.sqlMode') : t('panels.shellMode')}
        </span>
        <span className="row gap5" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <Icon name="link" size={11} style={{ color: 'var(--text-faint)' }} />
          <span>{t('panels.followActiveTab', { target })}</span>
        </span>
      </div>
      {/* quick actions removed — actions live in the composer flow */}
      <div className="grow" style={{ overflowY: 'auto', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {thread.map((m, i) => m.role === 'user'
          ? <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', background: 'var(--accent-primary)', color: 'var(--on-accent)', padding: '9px 12px', borderRadius: '14px 14px 4px 14px', fontSize: 13, lineHeight: 1.5 }}>{m.text}</div>
          : <AgentMessage key={i} m={m} />)}
      </div>
      {/* composer */}
      <div style={{ padding: 10, borderTop: '1px solid var(--border-hairline)' }}>
        {/* attached terminal/SQL output — piped in via "问 AI" */}
        {attachment && (
          <div className="col pop-in" style={{ border: '1px solid var(--accent-border)', background: 'var(--accent-soft-alt)', borderRadius: 11, padding: '8px 10px', marginBottom: 8 }}>
            <div className="row gap6" style={{ marginBottom: 5 }}>
              <Icon name={attachment.kind === 'sql' ? 'database' : 'terminal'} size={12} style={{ color: 'var(--accent-primary)' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-primary)' }}>{t('panels.attachedOutput', { target: attachment.target })}</span>
              <span className="grow" />
              <button className="icon-btn bare" style={{ width: 20, height: 20 }} title={t('panels.removeAttachment')} onClick={onClearAttachment}><Icon name="x" size={12} /></button>
            </div>
            <pre className="mono" style={{ margin: 0, fontSize: 10.8, lineHeight: 1.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 92, overflowY: 'auto', wordBreak: 'break-all' }}>{attachment.text}</pre>
          </div>
        )}
        <div className="col" style={{ background: 'var(--surface-sunken)', border: `1px solid ${attachment ? 'var(--accent-border)' : 'var(--border-hairline)'}`, borderRadius: 12, padding: 8 }}>
          <textarea ref={taRef} value={draft} onChange={e => setDraft(e.target.value)}
            placeholder={attachment ? t('panels.composerPlaceholderAttached') : (isSql ? t('panels.composerPlaceholderSql') : t('panels.composerPlaceholderShell', { target }))}
            rows={2} style={{ border: 'none', outline: 'none', background: 'transparent', resize: 'none', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit' }} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <div className="row gap4">
              <button className="icon-btn bare" style={{ width: 26, height: 26 }} title={t('panels.attachContext')}><Icon name="plus" size={15} /></button>
              <button className="icon-btn bare" style={{ width: 26, height: 26 }} title={t('panels.selectModel')}><Icon name="box" size={14} /></button>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', alignSelf: 'center' }}>{t('panels.modelInfo')}</span>
            </div>
            <button className="btn btn-primary sm" style={{ width: 32, padding: 0 }} title={t('panels.send')}><Icon name="send" size={14} /></button>
          </div>
        </div>
      </div>
    </PanelShell>
  )
}
