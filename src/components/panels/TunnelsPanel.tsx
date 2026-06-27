/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn, Toggle, Segmented, Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Tunnel } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { getTunnels, tunnelOpen, tunnelClose, listen } from '../../services/ssh'
import type { ConnectionProfile } from '../../state/connections'

export interface JumpChainItem {
  name: string
  kind: 'local' | 'jump' | 'target'
  detail?: string
}

export interface TunnelsPanelProps {
  onClose: () => void
  sessionId?: string
  /** connId of the active tab — used to look up the jump chain. */
  activeConnId?: string
  /** All saved profiles — used to derive the real jump chain. */
  profiles?: ConnectionProfile[]
  /** Persist this forward as a reusable connection (C2). Absent → no save UI. */
  onSaveProfile?: (kind: 'L' | 'R' | 'D', bind: string, target: string, name: string) => void
}

// ---- New-forward overlay form ----
interface NewForwardFormProps {
  onSubmit: (kind: 'L' | 'R' | 'D', bind: string, target: string) => void
  onCancel: () => void
  onSaveProfile?: (kind: 'L' | 'R' | 'D', bind: string, target: string, name: string) => void
}

function NewForwardForm({ onSubmit, onCancel, onSaveProfile }: NewForwardFormProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<'L' | 'R' | 'D'>('L')
  const [bind, setBind] = useState('')
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!bind.trim()) return
    onSubmit(kind, bind.trim(), target.trim())
  }

  const inputStyle: React.CSSProperties = {
    height: 30, padding: '0 10px', borderRadius: 8, fontSize: 12,
    border: '1px solid var(--border-default)', background: 'var(--surface-sunken)',
    color: 'var(--text-primary)', outline: 'none', width: '100%', boxSizing: 'border-box',
  }

  return (
    <form onSubmit={handleSubmit}
      style={{
        position: 'absolute', top: 40, right: 12, zIndex: 20,
        background: 'var(--surface-card)', border: '1px solid var(--border-default)',
        borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: 'var(--shadow-overlay, 0 8px 24px rgba(0,0,0,.18))', width: 260,
        animation: 'growUp .14s ease',
      }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
        {t('panels.newForward')}
      </span>
      <Segmented
        size="sm"
        options={[
          { value: 'L', label: t('panels.fwdLocal') },
          { value: 'R', label: t('panels.fwdRemote') },
          { value: 'D', label: t('panels.fwdDynamic') },
        ]}
        value={kind}
        onChange={v => setKind(v as 'L' | 'R' | 'D')}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.fwdBind')}</span>
        <input
          style={inputStyle}
          placeholder="localhost:8080"
          value={bind}
          onChange={e => setBind(e.target.value)}
          autoFocus
        />
      </div>
      {kind !== 'D' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.fwdTarget')}</span>
          <input
            style={inputStyle}
            placeholder="10.0.4.2:5432"
            value={target}
            onChange={e => setTarget(e.target.value)}
          />
        </div>
      )}
      {onSaveProfile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.fwdSaveName')}</span>
          <input style={inputStyle} placeholder={t('panels.fwdSaveNamePlaceholder')} value={name} onChange={e => setName(e.target.value)} />
        </div>
      )}
      <div className="row gap6" style={{ justifyContent: 'flex-end' }}>
        <Btn variant="ghost" size="sm" onClick={onCancel}>{t('panels.cancel')}</Btn>
        {onSaveProfile && (
          <Btn variant="ghost" size="sm" onClick={() => { if (bind.trim() && name.trim()) onSaveProfile(kind, bind.trim(), target.trim(), name.trim()) }} disabled={!bind.trim() || !name.trim()}>{t('panels.fwdSave')}</Btn>
        )}
        <Btn variant="primary" size="sm" onClick={() => handleSubmit()} disabled={!bind.trim()}>{t('panels.fwdAdd')}</Btn>
      </div>
    </form>
  )
}

// ---- Main panel ----

export function TunnelsPanel({ onClose, sessionId, activeConnId, profiles, onSaveProfile }: TunnelsPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const typeLabel: Record<string, string> = { L: 'Local', R: 'Remote', D: 'Dynamic' }

  // Derive the real jump chain from the active profile (or fall back to mock D.jumpChain).
  const activeProfile = profiles && activeConnId
    ? profiles.find(p => p.id === activeConnId)
    : undefined

  const jumpChain: JumpChainItem[] = activeProfile
    ? [
        { name: '本地', kind: 'local' as const },
        ...(activeProfile.jump
          ? [{
              name: activeProfile.jump.host,
              kind: 'jump' as const,
              detail: `${activeProfile.jump.user}@${activeProfile.jump.host}:${activeProfile.jump.port}`,
            }]
          : []),
        {
          name: activeProfile.name,
          kind: 'target' as const,
          detail: `${activeProfile.user}@${activeProfile.host}:${activeProfile.port}`,
        },
      ]
    : D.jumpChain

  const [tunnels, setTunnels] = useState<Tunnel[]>([])
  const [showForm, setShowForm] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  const load = () => {
    getTunnels(sessionId).then(list => setTunnels(list)).catch(() => {
      // keep current state on error
    })
  }

  // Load on mount and sessionId change
  useEffect(() => {
    if (sessionId) {
      load()
    } else {
      setTunnels([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Subscribe to per-tunnel live byte-count events
  useEffect(() => {
    if (!sessionId) return
    const unlisteners: Array<() => void> = []
    tunnels.forEach(t2 => {
      listen<{ bytesUp: number; bytesDown: number }>(`tunnel://${t2.id}`, payload => {
        setTunnels(prev =>
          prev.map(row =>
            row.id === t2.id
              ? { ...row, bytes: formatBytesLocal(payload.bytesUp + payload.bytesDown) }
              : row,
          ),
        )
      }).then(unlisten => unlisteners.push(unlisten))
    })
    return () => { unlisteners.forEach(fn => fn()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tunnels.map(t2 => t2.id).join(',')])

  // Close overlay when clicking outside
  useEffect(() => {
    if (!showForm) return
    const handler = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setShowForm(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showForm])

  const handleToggle = (t2: Tunnel, nowOn: boolean) => {
    if (!sessionId) return
    if (!nowOn && t2.status === 'up') {
      // OFF → close tunnel
      tunnelClose(t2.id).then(() => load()).catch(() => load())
    }
    // ON → reopening a closed tunnel needs original spec; not wired (deferred)
  }

  const handleCreate = (kind: 'L' | 'R' | 'D', bind: string, target: string) => {
    if (!sessionId) return
    setShowForm(false)
    tunnelOpen(sessionId, { kind, bind, target: kind === 'D' ? null : target || null })
      .then(() => load())
      .catch(() => load())
  }

  return (
    <PanelShell
      icon="link"
      title={t('panels.tunnelsTitle')}
      sub={t('panels.tunnelsSub')}
      onClose={onClose}
      actions={
        <div ref={overlayRef} style={{ position: 'relative' }}>
          <IconBtn
            name="plus"
            size={15}
            variant="bare"
            title={t('panels.newForward')}
            onClick={() => setShowForm(v => !v)}
            active={showForm}
          />
          {showForm && (
            <NewForwardForm
              onSubmit={handleCreate}
              onCancel={() => setShowForm(false)}
              onSaveProfile={onSaveProfile ? (kind, bind, target, name) => { setShowForm(false); onSaveProfile(kind, bind, target, name) } : undefined}
            />
          )}
        </div>
      }
    >
      {!sessionId ? (
        <PanelEmpty icon="link" text={t('panels.noSessionHint')} />
      ) : (
        <>
          {/* jump chain — only shown when there is a jump hop or always for session context */}
          {jumpChain.length > 0 && (
            <div className="col" style={{ padding: '12px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>ProxyJump</span>
              <div className="row" style={{ gap: 0, flexWrap: 'wrap' }}>
                {jumpChain.map((h, i) => (
                  <React.Fragment key={i}>
                    <div className="row gap6" style={{ padding: '5px 9px', borderRadius: 8, background: h.kind === 'target' ? 'var(--accent-soft)' : 'var(--surface-sunken)' }}
                      title={h.detail}>
                      <Icon name={h.kind === 'local' ? 'monitor' : h.kind === 'jump' ? 'shield' : 'server'} size={13} style={{ color: h.kind === 'target' ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} />
                      <span className="mono" style={{ fontSize: 11.5, color: h.kind === 'target' ? 'var(--accent-primary)' : 'var(--text-secondary)', fontWeight: h.kind === 'target' ? 600 : 400 }}>{h.name}</span>
                    </div>
                    {i < jumpChain.length - 1 && <Icon name="arrow-right" size={13} style={{ color: 'var(--text-disabled)', margin: '0 4px' }} />}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          <div className="grow" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tunnels.map(t2 => (
              <div key={t2.id} className="col" style={{ border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 11, gap: 8, background: 'var(--surface-card)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row gap8">
                    <div className="icon-badge" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--surface-sunken)', color: 'var(--text-tertiary)' }}><span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{t2.type}</span></div>
                    <div className="col" style={{ lineHeight: 1.25 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t2.label}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{typeLabel[t2.type]} · via {t2.via}</span>
                    </div>
                  </div>
                  <Toggle on={t2.status === 'up'} size="sm" onChange={nowOn => handleToggle(t2, nowOn)} />
                </div>
                <div className="row mono gap6" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  <span style={{ color: 'var(--signal-green)' }}>{t2.local}</span>
                  <Icon name="arrow-right" size={11} />
                  <span>{t2.remote}</span>
                  <span className="grow" />
                  <span style={{ color: 'var(--text-faint)' }}>{t2.bytes}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </PanelShell>
  )
}

// local copy to avoid circular imports in this module
function formatBytesLocal(n: number): string {
  if (n === 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
