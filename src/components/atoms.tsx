/* ported from ref-ui/_extract/blob3.txt — verbatim per plan T1-T7 */
import React from 'react'
import { Icon } from './Icon'
import { useData } from '../state/DataContext'
import { dbLogo, osLogo } from '../services/logos'
import type { Connection } from '../services/types'

// ---- Keyframes injected once ----
;(function injectKeyframes() {
  if (typeof document === 'undefined') return
  if (document.getElementById('catio-kf')) return
  const st = document.createElement('style')
  st.id = 'catio-kf'
  st.textContent = `
    @keyframes ping { 75%,100% { transform: scale(2.4); opacity: 0; } }
    @keyframes blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes slideInRight { from { opacity:0; transform: translateX(16px);} to {opacity:1; transform:none;} }
    @keyframes growUp { from { opacity:0; transform: scaleY(.96); } to { opacity:1; transform:none; } }
  `
  document.head.appendChild(st)
})()

// ---- Prop types ----

export interface BtnProps {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'cta'
  size?: 'sm' | 'md' | 'lg'
  icon?: string
  iconR?: string
  children?: React.ReactNode
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  style?: React.CSSProperties
  title?: string
  disabled?: boolean
}

export interface IconBtnProps {
  name: string
  size?: number
  variant?: string
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  title?: string
  style?: React.CSSProperties
  active?: boolean
}

export interface ToggleProps {
  on: boolean
  onChange?: (value: boolean) => void
  size?: 'sm' | 'md'
  accent?: boolean
}

export interface ChipProps {
  children?: React.ReactNode
  icon?: string
  mono?: boolean
  style?: React.CSSProperties
}

export interface IconBadgeProps {
  icon?: string
  size?: number
  radius?: number
  color?: string
  bg?: string
  style?: React.CSSProperties
  children?: React.ReactNode
}

export type StatusKind = 'up' | 'idle' | 'down' | 'error'

export interface StatusDotProps {
  status: StatusKind
  size?: number
}

export interface ConnGlyphProps {
  conn: Connection
  size?: number
  radius?: number
}

export interface SegmentedOption {
  value: string
  label?: string
  icon?: string
  disabled?: boolean
  testId?: string
}

export interface SegmentedProps {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  size?: 'sm' | 'md'
}

export interface SectionHeadProps {
  title: React.ReactNode
  count?: number | null
  hint?: React.ReactNode
  right?: React.ReactNode
}

// ---- Components ----

export function Btn({ variant = 'secondary', size = 'md', icon, iconR, children, onClick, style, title, disabled }: BtnProps) {
  return (
    <button className={`btn btn-${variant} ${size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : ''}`}
      onClick={onClick} style={style} title={title} disabled={disabled}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 15} />}
      {children}
      {iconR && <Icon name={iconR} size={size === 'sm' ? 14 : 15} />}
    </button>
  )
}

export function IconBtn({ name, size = 16, variant = '', onClick, title, style, active }: IconBtnProps) {
  return (
    <button className={`icon-btn ${variant}`} onClick={onClick} title={title} style={style}
      data-active={active ? '1' : undefined}>
      <Icon name={name} size={size} />
    </button>
  )
}

export function Toggle({ on, onChange, size = 'md', accent }: ToggleProps) {
  return (
    <div className={`toggle ${size === 'sm' ? 'sm' : ''} ${on ? 'on' : ''} ${accent ? 'accent' : ''}`}
      onClick={(e) => { e.stopPropagation(); onChange && onChange(!on) }} role="switch" aria-checked={on}>
      <div className="knob" />
    </div>
  )
}

export function Chip({ children, icon, mono, style }: ChipProps) {
  return (
    <span className="chip" style={style}>
      {icon && <Icon name={icon} size={11} />}
      <span className={mono ? 'mono' : ''}>{children}</span>
    </span>
  )
}

export function IconBadge({ icon, size = 42, radius = 10, color, bg, style, children }: IconBadgeProps) {
  const iSize = size <= 30 ? 15 : size <= 42 ? 18 : 22
  return (
    <div className="icon-badge" style={{ width: size, height: size, borderRadius: radius, color: color || 'var(--text-secondary)', background: bg || 'var(--surface-sunken)', ...style }}>
      {children || <Icon name={icon ?? 'circle'} size={iSize} />}
    </div>
  )
}

export function StatusDot({ status, size = 7 }: StatusDotProps) {
  const map: Record<string, string> = {
    up: 'var(--signal-green)', idle: 'var(--signal-amber)',
    down: 'var(--text-faint)', error: 'var(--danger-fg)',
  }
  const pulse = status === 'up'
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span className="dot" style={{ width: size, height: size, background: map[status] || 'var(--text-faint)' }} />
      {pulse && <span className="dot" style={{ position: 'absolute', inset: 0, width: size, height: size, background: map[status], animation: 'ping 1.8s cubic-bezier(0,0,.2,1) infinite' }} />}
    </span>
  )
}

/* Connection glyph: real brand LOGO when available, else a tinted fallback.
   - DB: full-colour engine logo on a clean tile; falls back to the engine short code.
   - Host: OS logo tinted to the brand colour (CSS mask); falls back to the OS-tinted
     generic icon until the backend detects the real OS post-connect. */
export function ConnGlyph({ conn, size = 42, radius = 10 }: ConnGlyphProps) {
  const D = useData()
  const small = size <= 32
  if (conn.kind === 'db') {
    // Brand glyph/logo prefers the catalog variant id (engineId) so e.g. a
    // CockroachDB connection shows its own mark; falls back to the family.
    const glyphId = conn.engineId ?? conn.engine
    const m = D.engineMeta[glyphId ?? ''] || { short: 'DB', color: 'var(--text-tertiary)' }
    const logo = dbLogo(glyphId)
    if (logo) {
      return (
        <div className="icon-badge" style={{ width: size, height: size, borderRadius: radius, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', padding: small ? 4 : 6 }}>
          <img src={logo} alt={m.short} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
      )
    }
    return (
      <div className="icon-badge" style={{ width: size, height: size, borderRadius: radius, background: `color-mix(in srgb, ${m.color} 14%, var(--surface-card))`, color: m.color, border: `1px solid color-mix(in srgb, ${m.color} 26%, transparent)` }}>
        <span className="mono" style={{ fontSize: small ? 9 : 10, fontWeight: 700, letterSpacing: '.02em' }}>{m.short}</span>
      </div>
    )
  }
  const ol = osLogo(conn.os)
  if (ol) {
    const m = small ? 4 : 6
    return (
      <div className="icon-badge" style={{ width: size, height: size, borderRadius: radius, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)' }}>
        <span style={{ display: 'block', width: size - m * 2, height: size - m * 2, backgroundColor: ol.color, WebkitMaskImage: `url(${ol.url})`, maskImage: `url(${ol.url})`, WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskPosition: 'center', maskPosition: 'center', WebkitMaskSize: 'contain', maskSize: 'contain' }} />
      </div>
    )
  }
  const om = D.osMeta[conn.os ?? ''] || { color: 'var(--text-tertiary)' }
  return (
    <div className="icon-badge" style={{ width: size, height: size, borderRadius: radius, background: `color-mix(in srgb, ${om.color} 12%, var(--surface-card))`, color: om.color, border: `1px solid color-mix(in srgb, ${om.color} 22%, transparent)` }}>
      <Icon name={conn.icon || 'server'} size={small ? 15 : 18} />
    </div>
  )
}

/* Segmented control */
export function Segmented({ options, value, onChange, size = 'md' }: SegmentedProps) {
  return (
    <div className="segmented" style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'var(--surface-sunken)', borderRadius: 10, border: '1px solid var(--border-hairline)' }}>
      {options.map(o => {
        const active = o.value === value
        return (
          <button key={o.value} onClick={() => !o.disabled && onChange(o.value)} title={o.label}
            disabled={o.disabled} data-testid={o.testId}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: size === 'sm' ? 24 : 28, padding: o.icon && !o.label ? '0 7px' : '0 11px',
              borderRadius: 7, fontSize: 12, fontWeight: 600,
              color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
              background: active ? 'var(--surface-card)' : 'transparent',
              boxShadow: active ? 'var(--shadow-card)' : 'none',
              transition: 'all .14s',
            }}>
            {o.icon && <Icon name={o.icon} size={14} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* Section header (§5.1) */
export function SectionHead({ title, count, hint, right }: SectionHeadProps) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
      <div className="row gap10">
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-primary)' }}>{title}</h2>
        {count != null && <span className="badge-accent" style={{ height: 22, fontSize: 11 }}>{count}</span>}
        {hint && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{hint}</span>}
      </div>
      {right}
    </div>
  )
}
