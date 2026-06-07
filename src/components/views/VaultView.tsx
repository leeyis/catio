/* ported from ref-ui/_extract/blob4.txt — verbatim per plan T1-T7 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, ConnGlyph, Segmented, StatusDot } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'

// ---- Prop types ----

export interface VaultViewProps {
  onOpen: (conn: Connection) => void
  onDetail: (conn: Connection) => void
  onNew: () => void
  viewMode: 'grid' | 'list' | 'tree'
  onViewMode: (mode: 'grid' | 'list' | 'tree') => void
}

interface EntityCardProps {
  conn: Connection
  onOpen: (conn: Connection) => void
  onDetail: (conn: Connection) => void
}

function EntityCard({ conn, onOpen, onDetail }: EntityCardProps) {
  const D = useData()
  const { t } = useTranslation()
  const [hover, setHover] = React.useState(false)
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={() => onOpen(conn)}
      style={{ background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 20, padding: 18, cursor: 'pointer', boxShadow: hover ? 'var(--shadow-pill)' : 'var(--shadow-card)', transform: hover ? 'translateY(-2px)' : 'none', transition: 'all .14s' }}>
      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
        <ConnGlyph conn={conn} size={48} radius={14} />
        <div className="col grow" style={{ minWidth: 0, gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
              <span className="ell" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{conn.name}</span>
              <span className="ell mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{conn.sub}</span>
            </div>
            <div className="row gap4" style={{ opacity: hover ? 1 : 0, transition: 'opacity .12s' }}>
              <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={e => { e.stopPropagation(); onDetail(conn) }}><Icon name="pencil" size={14} /></button>
              <button className="icon-btn danger" style={{ width: 30, height: 30, background: 'var(--danger-soft)', color: 'var(--danger-fg)' }} onClick={e => e.stopPropagation()}><Icon name="trash-2" size={14} /></button>
            </div>
          </div>
          <div className="row gap6" style={{ flexWrap: 'wrap' }}>
            <span className="chip"><StatusDot status={conn.status} size={6} /> {conn.kind === 'db' ? (D.engineMeta[conn.engine ?? ''] || {}).label : (D.osMeta[conn.os ?? ''] || {}).label || 'host'}</span>
            {conn.tunnel && <span className="chip"><Icon name="link" size={10} /> via {D.byId[conn.tunnel].name}</span>}
            {conn.stats && <span className="chip mono">CPU {conn.stats.cpu}%</span>}
            <span className="metadot" />
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('home.ago', { time: conn.lastUsed })}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

interface InfoRowProps {
  conn: Connection
  onOpen: (conn: Connection) => void
  onDetail?: (conn: Connection) => void
  showGroup?: boolean
}

function InfoRow({ conn, onOpen, onDetail, showGroup }: InfoRowProps) {
  const D = useData()
  const { t } = useTranslation()
  const [hover, setHover] = React.useState(false)
  const g = D.groups.find(x => x.id === conn.group)
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={() => onOpen(conn)}
      style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 14, padding: '12px 16px', cursor: 'pointer', boxShadow: hover ? 'var(--shadow-card)' : 'none', transition: 'box-shadow .12s' }}>
      <ConnGlyph conn={conn} size={42} radius={10} />
      <div className="col" style={{ lineHeight: 1.35, minWidth: 0, flex: 1 }}>
        <div className="row gap8" style={{ minWidth: 0 }}>
          <span className="ell" style={{ fontSize: 14.5, fontWeight: 600 }}>{conn.name}</span>
          {conn.status === 'up' && <span className="badge-accent" style={{ background: 'color-mix(in srgb, var(--signal-green) 13%, transparent)', color: 'var(--signal-green)' }}><Icon name="check" size={10} /> {t('vault.online')}</span>}
          {conn.tunnel && <Icon name="link" size={12} style={{ color: 'var(--text-faint)' }} />}
        </div>
        <span className="ell mono" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{conn.sub}</span>
      </div>
      {showGroup && g && <span className="chip"><span className="dot" style={{ background: g.color }} /> {g.name}</span>}
      <div className="row gap6" style={{ flexWrap: 'wrap', maxWidth: 200, justifyContent: 'flex-end' }}>
        {(conn.tags || []).slice(0, 2).map(tag => <span key={tag} className="chip mono" style={{ height: 20, fontSize: 10 }}>{tag}</span>)}
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-faint)', width: 56, textAlign: 'right' }}>{t('home.ago', { time: conn.lastUsed })}</span>
      {hover ? (
        <div className="row gap4">
          <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={e => { e.stopPropagation(); onDetail && onDetail(conn) }}><Icon name="info" size={14} /></button>
          <button className="btn btn-primary sm" onClick={e => { e.stopPropagation(); onOpen(conn) }}><Icon name="play" size={13} /> {t('home.connect')}</button>
        </div>
      ) : <Icon name="chevron-right" size={16} style={{ color: 'var(--text-disabled)' }} />}
    </div>
  )
}

interface VaultTreeProps {
  conns: Connection[]
  onOpen: (conn: Connection) => void
  onDetail: (conn: Connection) => void
}

function VaultTree({ conns, onOpen, onDetail }: VaultTreeProps) {
  const D = useData()
  return (
    <div className="card-surface" style={{ padding: 12, maxWidth: 720 }}>
      {D.groups.map(g => {
        const items = conns.filter(c => c.group === g.id)
        if (!items.length) return null
        return (
          <div key={g.id} style={{ marginBottom: 6 }}>
            <div className="row gap8" style={{ padding: '8px 8px' }}>
              <Icon name="chevron-down" size={14} style={{ color: 'var(--text-faint)' }} />
              <span className="dot" style={{ background: g.color }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>{g.name}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{items.length}</span>
            </div>
            {items.map(c => (
              <div key={c.id} onClick={() => onOpen(c)} className="row gap10" style={{ padding: '8px 10px 8px 30px', borderRadius: 10, cursor: 'pointer', position: 'relative' }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-sunken)'} onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}>
                <span style={{ position: 'absolute', left: 16, top: 0, bottom: 0, width: 1, background: 'var(--border-hairline)' }} />
                <ConnGlyph conn={c} size={28} radius={8} />
                <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</span>
                <span className="ell" style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>{c.sub}</span>
                <StatusDot status={c.status} size={6} />
                <button className="icon-btn bare" style={{ width: 24, height: 24 }} onClick={e => { e.stopPropagation(); onDetail(c) }}><Icon name="info" size={13} /></button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

export function VaultView({ onOpen, onDetail, onNew, viewMode, onViewMode }: VaultViewProps) {
  const D = useData()
  const { t } = useTranslation()
  const [filter, setFilter] = React.useState('all')
  const conns = D.connections.filter(c => filter === 'all' || c.kind === filter)
  return (
    <div className="grow fade-in" style={{ overflowY: 'auto' }}>
      <div style={{ padding: '24px 32px 40px' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
          <div className="row gap10">
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.4px' }}>Vault</h1>
            <span className="badge-accent" style={{ height: 22, fontSize: 11 }}>{t('vault.connections', { count: D.connections.length })}</span>
            <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 12%, transparent)', color: 'var(--signal-green)' }}><Icon name="lock" size={11} /> {t('vault.encryptedVault')}</span>
          </div>
          <div className="row gap8">
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: t('vault.filterAll') }, { value: 'host', label: t('vault.filterHost'), icon: 'server' }, { value: 'db', label: t('vault.filterDb'), icon: 'database' }]} />
            <div style={{ width: 1, height: 22, background: 'var(--border-hairline)' }} />
            <Segmented value={viewMode} onChange={onViewMode as (v: string) => void} options={[{ value: 'grid', icon: 'layout-grid' }, { value: 'list', icon: 'list' }, { value: 'tree', icon: 'git-branch' }]} />
            <Btn variant="cta" icon="plus" onClick={onNew}>{t('vault.newBtn')}</Btn>
          </div>
        </div>

        {viewMode === 'grid' && (
          <div className="col gap16">
            {D.groups.map(g => {
              const items = conns.filter(c => c.group === g.id)
              if (!items.length) return null
              return (
                <div key={g.id}>
                  <div className="row gap8" style={{ marginBottom: 12 }}><span className="dot" style={{ background: g.color }} /><span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.3px', color: 'var(--text-secondary)' }}>{g.name}</span><span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{items.length}</span></div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
                    {items.map(c => <EntityCard key={c.id} conn={c} onOpen={onOpen} onDetail={onDetail} />)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {viewMode === 'list' && (
          <div className="col gap8">
            {conns.map(c => <InfoRow key={c.id} conn={c} onOpen={onOpen} onDetail={onDetail} showGroup />)}
          </div>
        )}
        {viewMode === 'tree' && <VaultTree conns={conns} onOpen={onOpen} onDetail={onDetail} />}
      </div>
    </div>
  )
}
