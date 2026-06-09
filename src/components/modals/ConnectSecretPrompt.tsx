import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn, IconBtn } from '../atoms'
import { Icon } from '../Icon'

export interface ConnectSecretPromptProps {
  title?: string
  label: string
  /** Inline error (e.g. auth failure) shown below the field; keeps the prompt open. */
  error?: string | null
  onSubmit: (secret: string) => void
  onCancel: () => void
}

export function ConnectSecretPrompt({ title, label, error, onSubmit, onCancel }: ConnectSecretPromptProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  function handleSubmit() {
    const secret = value
    setValue('')
    onSubmit(secret)
  }

  function handleCancel() {
    setValue('')
    onCancel()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSubmit()
    if (e.key === 'Escape') handleCancel()
  }

  return (
    <div
      onClick={handleCancel}
      style={{
        position: 'absolute', inset: 0, zIndex: 70,
        background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)',
        backdropFilter: 'blur(3px)',
        display: 'grid', placeItems: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="pop-in"
        style={{
          width: 360,
          background: 'var(--surface-card)',
          borderRadius: 18,
          border: '1px solid var(--border-hairline)',
          boxShadow: 'var(--shadow-window)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>
            {title ?? label}
          </span>
          <IconBtn name="x" size={16} variant="bare" onClick={handleCancel} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 8, padding: '16px 20px 20px' }}>
          <label className="col" style={{ gap: 5 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
            <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
              <input
                type="password"
                autoFocus
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="••••••••"
                className="mono"
                style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }}
              />
            </div>
          </label>
          {error && (
            <div className="row gap6" style={{ alignItems: 'flex-start', fontSize: 12, color: 'var(--danger-fg)', lineHeight: 1.45 }}>
              <Icon name="alert-triangle" size={13} style={{ flex: 'none', marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}
          <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn variant="ghost" onClick={handleCancel}>{t('modals.secretPromptCancel')}</Btn>
            <Btn variant="primary" icon="check" onClick={handleSubmit}>{t('modals.secretPromptSubmit')}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
