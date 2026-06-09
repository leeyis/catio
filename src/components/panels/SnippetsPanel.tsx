/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7; real CRUD per S2 */
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn, Btn } from '../atoms'
import type { Snippet } from '../../services/types'
import { PanelShell } from './PanelShell'
import { ConfirmModal } from '../modals/ConfirmModal'
import { saveSnippet, deleteSnippet, newSnippetId } from '../../state/snippets'

export interface SnippetsPanelProps {
  onClose: () => void
  /** Snippets from the real store (App passes loadSnippets()). */
  snippets: Snippet[]
  /** Called after any mutation so App can re-read the store. */
  onChange?: () => void
  /** Insert the snippet code into the active terminal. */
  onInsert?: (text: string) => void
  /** Whether insert is currently possible (an active live terminal exists). */
  canInsert?: boolean
}

interface SnippetRowProps {
  s: Snippet
  onInsert?: (text: string) => void
  canInsert?: boolean
  onEdit: (s: Snippet) => void
  onDelete: (s: Snippet) => void
}

function SnippetRow({ s, onInsert, canInsert, onEdit, onDelete }: SnippetRowProps) {
  const { t } = useTranslation()
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const isShell = s.scope === 'Shell'
  const code = s.code || ''
  const insertEnabled = !!onInsert && !!canInsert
  function copy(e: React.MouseEvent) {
    e.stopPropagation()
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  function run(e: React.MouseEvent) {
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('catio-run', { detail: { kind: isShell ? 'shell' : 'sql', text: code } }))
  }
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="col" style={{ padding: '9px 10px', borderRadius: 10, border: '1px solid var(--border-hairline)', gap: 6, background: hover ? 'var(--surface-sunken)' : 'transparent', transition: 'background .12s' }}>
      <div className="row gap8" style={{ minWidth: 0 }}>
        <Icon name={s.icon} size={14} style={{ color: isShell ? 'var(--signal-amber)' : 'var(--signal-blue)', flex: 'none' }} />
        <span className="ell" style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>{s.desc || (isShell ? t('panels.shellCommand') : t('panels.sqlCode'))}</span>
        <span className="chip" style={{ height: 18, fontSize: 9.5, flex: 'none' }}>{s.scope}</span>
        {/* hover actions */}
        {/* action order (per spec): 复制 / 插入 / 运行 / 编辑 / 删除 */}
        <div className="row gap2" style={{ flex: 'none', width: hover ? 'auto' : 0, overflow: 'hidden', opacity: hover ? 1 : 0, transition: 'opacity .12s' }}>
          <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={copied ? t('panels.copied') : t('panels.copy')} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={13} style={copied ? { color: 'var(--signal-green)' } : undefined} />
          </button>
          {insertEnabled && (
            <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={isShell ? t('panels.insertTerminal') : t('panels.insertEditor')} onClick={e => { e.stopPropagation(); onInsert(code) }}>
              <Icon name={isShell ? 'terminal' : 'arrow-right-to-line'} size={13} />
            </button>
          )}
          <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={t('panels.runItem')} onClick={run}>
            <Icon name="play" size={13} />
          </button>
          <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={t('panels.editSnippet')} onClick={e => { e.stopPropagation(); onEdit(s) }}>
            <Icon name="pencil" size={13} />
          </button>
          <button className="icon-btn bare" style={{ width: 24, height: 24, color: 'var(--danger-fg)' }} title={t('panels.deleteSnippet')} onClick={e => { e.stopPropagation(); onDelete(s) }}>
            <Icon name="trash-2" size={13} />
          </button>
        </div>
      </div>
      <pre className="mono ell" style={{ margin: 0, fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}>{code.split('\n')[0]}{code.includes('\n') ? ' …' : ''}</pre>
    </div>
  )
}

interface SnippetEditorProps {
  /** Existing snippet to edit, or null to create a new one. */
  snippet: Snippet | null
  onClose: () => void
  onSaved: () => void
}

function SnippetEditor({ snippet, onClose, onSaved }: SnippetEditorProps) {
  const { t } = useTranslation()
  const [desc, setDesc] = useState(snippet?.desc ?? '')
  const [scope, setScope] = useState<'Shell' | 'SQL'>((snippet?.scope as 'Shell' | 'SQL') || 'Shell')
  const [code, setCode] = useState(snippet?.code ?? '')
  const isSql = scope === 'SQL'
  const field: React.CSSProperties = { height: 36, padding: '0 11px', borderRadius: 9, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none', width: '100%' }
  function save() {
    if (!code.trim()) return
    saveSnippet({
      id: snippet?.id ?? newSnippetId(),
      scope,
      desc: desc.trim(),
      icon: isSql ? 'database' : 'terminal',
      code,
    })
    onSaved()
    onClose()
  }
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} className="pop-in col" style={{ width: '100%', maxWidth: 320, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 16, boxShadow: 'var(--shadow-window)', overflow: 'hidden' }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '14px 16px 10px' }}>
          <div className="row gap8">
            <div className="icon-badge" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="snippet" size={15} /></div>
            <div className="col" style={{ lineHeight: 1.2 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{snippet ? t('panels.editSnippet') : t('panels.newSnippet')}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('panels.snippetsSub')}</span>
            </div>
          </div>
          <IconBtn name="x" size={15} variant="bare" onClick={onClose} />
        </div>
        <div className="col gap10" style={{ padding: '4px 16px 8px' }}>
          {/* scope toggle */}
          <div className="row gap6">
            {(['Shell', 'SQL'] as const).map(sc => {
              const on = scope === sc
              return (
                <button key={sc} onClick={() => setScope(sc)} className="row gap5"
                  style={{ flex: 1, height: 32, justifyContent: 'center', borderRadius: 9, fontSize: 12, fontWeight: 600, border: `1px solid ${on ? 'var(--accent-border)' : 'var(--border-hairline-alt)'}`, background: on ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: on ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}>
                  <Icon name={sc === 'SQL' ? 'database' : 'terminal'} size={13} /> {sc}
                </button>
              )
            })}
          </div>
          <label className="col gap5"><span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{isSql ? t('panels.sqlCodeLabel') : t('panels.shellCommandLabel')}</span>
            <textarea autoFocus value={code} onChange={e => setCode(e.target.value)} rows={3} className="mono" style={{ ...field, height: 'auto', padding: '8px 11px', lineHeight: 1.5, resize: 'none' }} /></label>
          <label className="col gap5"><span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('panels.descLabel')} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({t('panels.descOptional')})</span></span>
            <input value={desc} onChange={e => setDesc(e.target.value)} placeholder={t('panels.descPlaceholder')} style={field}
              onKeyDown={e => { if (e.key === 'Enter') save() }} /></label>
        </div>
        <div className="row gap8" style={{ padding: '10px 16px 14px', justifyContent: 'flex-end' }}>
          <Btn variant="ghost" size="sm" onClick={onClose}>{t('panels.cancel')}</Btn>
          <Btn variant="primary" size="sm" icon="check" onClick={save}>{t('panels.confirm')}</Btn>
        </div>
      </div>
    </div>
  )
}

export function SnippetsPanel({ onClose, snippets, onChange, onInsert, canInsert }: SnippetsPanelProps) {
  const { t } = useTranslation()
  // null = closed; { snippet: null } = create; { snippet } = edit.
  const [editor, setEditor] = useState<{ snippet: Snippet | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Snippet | null>(null)
  return (
    <PanelShell icon="snippet" title={t('panels.snippetsTitle')} sub={t('panels.snippetsSub')} onClose={onClose}
      actions={<IconBtn name="plus" size={15} variant="bare" title={t('panels.newSnippet')} onClick={() => setEditor({ snippet: null })} />}>
      <div className="grow" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {snippets.map(s => (
          <SnippetRow key={s.id} s={s} onInsert={onInsert} canInsert={canInsert}
            onEdit={sn => setEditor({ snippet: sn })} onDelete={sn => setPendingDelete(sn)} />
        ))}
      </div>
      {editor && (
        <SnippetEditor snippet={editor.snippet} onClose={() => setEditor(null)} onSaved={() => onChange?.()} />
      )}
      {pendingDelete && (
        <ConfirmModal
          title={t('panels.deleteSnippet')}
          message={t('panels.deleteSnippetConfirm')}
          confirmLabel={t('panels.deleteSnippet')}
          danger
          onConfirm={() => { deleteSnippet(pendingDelete.id); setPendingDelete(null); onChange?.() }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </PanelShell>
  )
}
