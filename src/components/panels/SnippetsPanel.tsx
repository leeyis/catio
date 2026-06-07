/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Snippet } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface SnippetsPanelProps {
  onClose: () => void
  snippets?: Snippet[]
}

interface SnippetRowProps {
  s: Snippet
}

function SnippetRow({ s }: SnippetRowProps) {
  const { t } = useTranslation()
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const isShell = s.scope === 'Shell'
  const code = s.code || ''
  function copy(e: React.MouseEvent) {
    e.stopPropagation()
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  function insert(e: React.MouseEvent) {
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('catio-insert', { detail: { text: code, kind: isShell ? 'shell' : 'sql' } }))
  }
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="col" style={{ padding: '9px 10px', borderRadius: 10, border: '1px solid var(--border-hairline)', gap: 6, background: hover ? 'var(--surface-sunken)' : 'transparent', transition: 'background .12s' }}>
      <div className="row gap8" style={{ minWidth: 0 }}>
        <Icon name={s.icon} size={14} style={{ color: isShell ? 'var(--signal-amber)' : 'var(--signal-blue)', flex: 'none' }} />
        <span className="ell" style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>{s.desc || (isShell ? t('panels.shellCommand') : t('panels.sqlCode'))}</span>
        <span className="chip" style={{ height: 18, fontSize: 9.5, flex: 'none' }}>{s.scope}</span>
        {/* hover actions */}
        <div className="row gap2" style={{ flex: 'none', width: hover ? 'auto' : 0, overflow: 'hidden', opacity: hover ? 1 : 0, transition: 'opacity .12s' }}>
          <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={isShell ? t('panels.insertTerminal') : t('panels.insertEditor')} onClick={insert}>
            <Icon name={isShell ? 'terminal' : 'arrow-right-to-line'} size={13} />
          </button>
          <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={copied ? t('panels.copied') : t('panels.copy')} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={13} style={copied ? { color: 'var(--signal-green)' } : undefined} />
          </button>
        </div>
      </div>
      <pre className="mono ell" style={{ margin: 0, fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}>{code.split('\n')[0]}{code.includes('\n') ? ' …' : ''}</pre>
    </div>
  )
}

export function SnippetsPanel({ onClose, snippets }: SnippetsPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const list = snippets || D.snippets
  return (
    <PanelShell icon="snippet" title={t('panels.snippetsTitle')} sub={t('panels.snippetsSub')} onClose={onClose} actions={<IconBtn name="plus" size={15} variant="bare" />}>
      <div className="grow" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.map(s => <SnippetRow key={s.id} s={s} />)}
      </div>
    </PanelShell>
  )
}
