import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'

export interface HostKeyPromptProps {
  host: string
  fingerprint: string
  onTrust: () => void
  onCancel: () => void
}

export function HostKeyPrompt({ host, fingerprint, onTrust, onCancel }: HostKeyPromptProps) {
  const { t } = useTranslation()

  return (
    <div
      onClick={onCancel}
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
          width: 380,
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
            {t('modals.hostKeyTitle')}
          </span>
          <IconBtn name="x" size={16} variant="bare" onClick={onCancel} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 10, padding: '16px 20px 20px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {t('modals.hostKeySub', { host })}
          </span>
          <div className="row gap8" style={{ alignItems: 'center', padding: '10px 12px', background: 'var(--surface-sunken)', borderRadius: 10 }}>
            <Icon name="key" size={13} style={{ color: 'var(--text-faint)', flex: 'none' }} />
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{fingerprint}</span>
          </div>
          <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn variant="ghost" onClick={onCancel}>{t('modals.hostKeyCancel')}</Btn>
            <Btn variant="primary" icon="check" onClick={onTrust}>{t('modals.hostKeyTrust')}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
