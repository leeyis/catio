/* ported from ref-ui/_extract/blob4.txt — verbatim per plan T1-T7 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { ConnGlyph, SectionHead } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'

// ---- Prop types ----

export interface HomeViewProps {
  onOpen: (conn: Connection) => void
  onNew: () => void
  onVault: () => void
  owned?: boolean
  userName?: string
  /** Whether local account auth is on — greeting shows a name only when true. */
  authEnabled?: boolean
  /** Real saved connections (from the vault). Empty on a fresh install. */
  conns?: Connection[]
}

interface StatProps {
  n: number
  label: string
  icon: string
}

function Stat({ n, label, icon }: StatProps) {
  return (
    <div className="row gap8">
      <Icon name={icon} size={16} style={{ color: 'var(--accent-primary)' }} />
      <div className="col" style={{ lineHeight: 1.05 }}>
        <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{n}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{label}</span>
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

export function HomeView({ onOpen, onNew, onVault, owned = true, userName = '', authEnabled = false, conns = [] }: HomeViewProps) {
  const { t, i18n } = useTranslation()
  // Real time-based greeting + live date/time (was a hardcoded mock). Name only
  // when account auth is on (otherwise there is no real user to greet).
  const now = new Date()
  const hr = now.getHours()
  const greet = t(hr < 12 ? 'home.greetMorning' : hr < 18 ? 'home.greetAfternoon' : 'home.greetEvening')
  const greetLine = authEnabled && userName ? t('home.greetingWithName', { greet, name: userName }) : greet
  const lang = i18n.language || 'zh'
  const statusLine = now.toLocaleDateString(lang, { weekday: 'long' }) + ' · ' + now.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hour12: false })
  // Stats reflect REAL saved connections. Databases / active tunnels are not yet
  // wired to a real backend in this sub-project → 0.
  const hostCount = conns.filter(c => c.kind === 'host').length
  const dbCount = conns.filter(c => c.kind === 'db').length
  const tunnelCount = 0

  if (!owned) {
    return (
      <div className="grow fade-in" style={{ overflowY: 'auto', overflowX: 'hidden' }}>
        <div className="col" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '100%', gap: 18, padding: 40, textAlign: 'center' }}>
          <div className="logo-mark" style={{ width: 56, height: 56, borderRadius: 18 }}><span className="mono" style={{ fontSize: 26, fontWeight: 700 }}>&gt;_</span></div>
          <div className="col" style={{ gap: 6, maxWidth: 420 }}>
            <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.4px' }}>{t('home.welcomeTitle', { name: userName })}</span>
            <span style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, textWrap: 'pretty' }}>{t('home.welcomeDesc')}</span>
          </div>
          <div className="row gap8">
            <button className="btn btn-cta lg" onClick={onNew}><Icon name="plus" size={16} /> {t('common.newConnection')}</button>
          </div>
          <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 12%, transparent)', color: 'var(--signal-green)' }}><Icon name="shield" size={11} /> {t('home.localEncrypted')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="grow fade-in" style={{ overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '32px 40px 48px' }}>
        {/* Hero */}
        <div style={{ borderRadius: 20, background: 'var(--accent-soft-alt)', border: '1px solid var(--accent-border)', padding: '26px 30px', marginBottom: 32, position: 'relative', overflow: 'hidden' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
            <div className="col" style={{ gap: 14, maxWidth: 560 }}>
              <div className="row gap10">
                <div className="logo-mark" style={{ width: 40, height: 40, borderRadius: 13 }}><span className="mono" style={{ fontSize: 18, fontWeight: 700 }}>&gt;_</span></div>
                <div className="col" style={{ lineHeight: 1.1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)', letterSpacing: '0.3px' }}>{greetLine}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{statusLine}</span>
                </div>
              </div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: '-0.6px', color: 'var(--text-primary)', lineHeight: 1.2 }}>{t('home.heroTitle')}<br />{t('home.heroTitleLine2')}</h1>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-secondary)', textWrap: 'pretty' }}>{t('home.heroDesc')}</p>
              <div className="row gap16" style={{ marginTop: 4 }}>
                <Stat n={hostCount} label={t('home.statHosts')} icon="server" />
                <div style={{ width: 1, height: 30, background: 'var(--accent-border)' }} />
                <Stat n={dbCount} label={t('home.statDatabases')} icon="database" />
                <div style={{ width: 1, height: 30, background: 'var(--accent-border)' }} />
                <Stat n={tunnelCount} label={t('home.statActiveTunnels')} icon="link" />
              </div>
            </div>
            <div className="col gap8">
              <button className="btn btn-cta lg" onClick={onNew}><Icon name="plus" size={16} /> {t('common.newConnection')}</button>
              <button className="btn btn-secondary" onClick={onVault}><Icon name="terminal-square" size={15} /> {t('home.enterWorkbench')}</button>
            </div>
          </div>
        </div>

        {/* Recent — no real session history backend yet → empty state */}
        <SectionHead title={t('home.recentSessions')} count={0} />
        <div style={{ marginBottom: 32 }}>
          <EmptySection icon="history" text={t('home.recentEmpty')} />
        </div>

        {/* Automation + quick */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          <div>
            <SectionHead title={t('home.quickConnect')} hint={t('home.quickConnectHint')} />
            <div className="col gap8">
              {conns.length
                ? conns.slice(0, 3).map(c => <InfoRow key={c.id} conn={c} onOpen={onOpen} />)
                : <EmptySection icon="server" text={t('home.quickConnectEmpty')} />}
            </div>
          </div>
          <div>
            <SectionHead title={t('home.automation')} hint={t('home.automationHint')} />
            <div className="col gap8">
              <EmptySection icon="box" text={t('home.automationEmpty')} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Empty section placeholder (honest, tidy, no fake cards) ----

interface EmptySectionProps {
  icon: string
  text: string
}

function EmptySection({ icon, text }: EmptySectionProps) {
  return (
    <div className="col" style={{ alignItems: 'center', justifyContent: 'center', gap: 8, padding: '28px 16px', textAlign: 'center', border: '1px dashed var(--border-hairline)', borderRadius: 14, background: 'var(--surface-subtle)' }}>
      <div className="icon-badge" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}>
        <Icon name={icon} size={17} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{text}</span>
    </div>
  )
}
