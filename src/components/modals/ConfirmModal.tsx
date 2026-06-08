import { useTranslation } from 'react-i18next'
import { Btn, IconBtn } from '../atoms'

export interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }: ConfirmModalProps) {
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
            {title}
          </span>
          <IconBtn name="x" size={16} variant="bare" onClick={onCancel} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 10, padding: '16px 20px 20px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {message}
          </span>
          <div className="row gap8" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn variant="ghost" onClick={onCancel}>{cancelLabel ?? t('modals.cancel')}</Btn>
            <Btn variant={danger ? 'danger' : 'primary'} icon={danger ? 'trash-2' : 'check'} onClick={onConfirm}>{confirmLabel}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
