import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn, IconBtn } from '../atoms'
import { Icon } from '../Icon'
import type { DbObjectType } from '../../services/db'

/** 对象管理操作：删除 / 重命名 / 清空表 / 复制表结构。 */
export type ObjectAdminOp = 'drop' | 'rename' | 'truncate' | 'duplicate'

export interface ObjectAdminModalProps {
  op: ObjectAdminOp
  objectType: DbObjectType
  schema?: string
  /** 目标对象名（drop/truncate 的确认对象，rename/duplicate 的源对象）。 */
  name: string
  /**
   * 确认回调。drop/truncate 不带载荷（undefined）；rename 传新名称；duplicate 传新表名。
   * 实际执行交由父组件（拿着 connId 调用服务），本组件只负责确认门控。
   */
  onConfirm: (payload?: string) => void
  onCancel: () => void
}

/**
 * 危险/结构操作的统一二次确认弹窗。镜像 BroadcastConfirmModal 的遮罩 + pop-in 样式，
 * 不硬编码颜色（走 danger / accent 主题变量，主题切换正常）。
 *
 * - drop / truncate：破坏性，需输入对象名原文才放行（typed confirmation）。
 * - rename：输入新名称，非空且与原名不同才放行。
 * - duplicate：输入新表名，非空才放行。
 */
export function ObjectAdminModal({ op, schema, name, onConfirm, onCancel }: ObjectAdminModalProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')

  const destructive = op === 'drop' || op === 'truncate'
  const qualified = schema ? `${schema}.${name}` : name

  // 放行条件：破坏性操作要输入对象名原文；rename 要非空且与原名不同；duplicate 要非空。
  const trimmed = text.trim()
  const enabled =
    op === 'drop' || op === 'truncate' ? trimmed === name
    : op === 'rename' ? trimmed.length > 0 && trimmed !== name
    : /* duplicate */ trimmed.length > 0

  const title =
    op === 'drop' ? t('workbench.objAdmin.dropTitle', { name: qualified })
    : op === 'truncate' ? t('workbench.objAdmin.truncateTitle', { name: qualified })
    : op === 'rename' ? t('workbench.objAdmin.renameTitle', { name: qualified })
    : t('workbench.objAdmin.duplicateTitle')

  const inputLabel =
    op === 'rename' ? t('workbench.objAdmin.newNameLabel')
    : op === 'duplicate' ? t('workbench.objAdmin.targetNameLabel')
    : t('workbench.objAdmin.typeToConfirm', { name })

  const warn =
    op === 'drop' ? t('workbench.objAdmin.dropWarn', { name: qualified })
    : op === 'truncate' ? t('workbench.objAdmin.truncateWarn', { name: qualified })
    : ''

  function confirm() {
    if (!enabled) return
    onConfirm(destructive ? undefined : trimmed)
  }

  const accentBorder = destructive ? 'var(--danger-border)' : 'var(--border-hairline)'

  return (
    <div onClick={onCancel}
      style={{ position: 'absolute', inset: 0, zIndex: 90,
        background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)',
        display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in"
        style={{ width: 440, maxWidth: 'calc(100vw - 48px)', background: 'var(--surface-card)', borderRadius: 18,
          border: `1px solid ${accentBorder}`, boxShadow: 'var(--shadow-window)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column' }}>
        {/* 标题栏 */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <span className="row gap8" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px', color: destructive ? 'var(--danger-fg)' : undefined }}>
            {destructive && <Icon name="alert-triangle" size={16} />}
            {title}
          </span>
          <IconBtn name="x" size={16} variant="bare" onClick={onCancel} />
        </div>

        {/* 主体 */}
        <div className="col" style={{ gap: 12, padding: '16px 20px 18px' }}>
          {warn && (
            <div className="row gap8" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--danger-soft)', border: '1px solid var(--danger-border)', color: 'var(--danger-fg)', fontSize: 12.5, lineHeight: 1.5 }}>
              <Icon name="alert-triangle" size={14} style={{ flex: 'none', marginTop: 1 }} />
              <span>{warn}</span>
            </div>
          )}
          <div className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{inputLabel}</span>
            <input data-testid="obj-admin-input" value={text} onChange={e => setText(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === 'Enter') confirm() }}
              style={{ height: 34, padding: '0 12px', borderRadius: 9, fontSize: 13, background: 'var(--surface-sunken)',
                border: `1px solid ${enabled ? 'var(--accent-primary)' : accentBorder}`, color: 'var(--text-primary)', outline: 'none' }} />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
            <Btn testId="obj-admin-cancel" variant="ghost" onClick={onCancel}>{t('workbench.objAdmin.cancel')}</Btn>
            <Btn testId="obj-admin-confirm" variant={destructive ? 'danger' : 'primary'} onClick={confirm}
              disabled={!enabled} style={!enabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
              {t('workbench.objAdmin.confirm')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
