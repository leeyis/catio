import { useTranslation } from 'react-i18next'
import { Btn, IconBtn } from '../atoms'
import { Icon } from '../Icon'

export interface AlertModalProps {
  title: string
  message: string
  /** Lucide icon name for the badge. Defaults to a warning triangle. */
  icon?: string
  /** Visual tone of the icon badge. */
  tone?: 'danger' | 'accent'
  confirmLabel?: string
  onClose: () => void
}

/** In-app alert dialog (replaces native window.alert). Mirrors ConfirmModal's
 *  overlay + pop-in styling so error feedback matches the app, not the OS. */
export function AlertModal({ title, message, icon = 'alert-triangle', tone = 'danger', confirmLabel, onClose }: AlertModalProps) {
  const { t } = useTranslation()
  const color = tone === 'danger' ? 'var(--danger-fg)' : 'var(--accent-primary)'
  const soft = tone === 'danger' ? 'var(--danger-soft)' : 'var(--accent-soft)'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 75,
        background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)',
        backdropFilter: 'blur(3px)',
        display: 'grid', placeItems: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="pop-in"
        style={{
          width: 400,
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
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{title}</span>
          <IconBtn name="x" size={16} variant="bare" onClick={onClose} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 14, padding: '18px 20px 20px' }}>
          <div className="row gap12" style={{ alignItems: 'flex-start' }}>
            <div className="icon-badge" style={{ width: 38, height: 38, borderRadius: 11, background: soft, color, flex: 'none' }}>
              <Icon name={icon} size={19} />
            </div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, paddingTop: 2 }}>{message}</span>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="primary" icon="check" onClick={onClose}>{confirmLabel ?? t('modals.ok')}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
