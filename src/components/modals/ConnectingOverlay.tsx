import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'

export interface ConnectingOverlayProps {
  /** Target name shown in the "Connecting to …" line. */
  name: string
}

/** Full-surface "connecting" overlay with a spinner — immediate feedback during
 *  a connection handshake (shared by the SSH host flow and the DB connect flow so
 *  both interactions feel identical). */
export function ConnectingOverlay({ name }: ConnectingOverlayProps) {
  const { t } = useTranslation()
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 74, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div className="pop-in col" style={{ alignItems: 'center', gap: 14, padding: '26px 34px', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)' }}>
        <Icon name="loader" size={26} className="spin" style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('modals.connectingTo', { name })}</span>
      </div>
    </div>
  )
}
