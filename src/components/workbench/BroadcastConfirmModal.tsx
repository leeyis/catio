import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn, IconBtn } from '../atoms'
import { Icon } from '../Icon'
import type { RiskCode } from './sensitiveCommands'

export interface BroadcastConfirmModalProps {
  /** 即将广播执行的命令原文 */
  cmd: string
  /** 含当前会话在内的全部目标主机 */
  targets: { id: string; name: string }[]
  /** 是否命中敏感/破坏性命令 */
  sensitive: boolean
  /** 命中的风险类别（去重） */
  reasons: RiskCode[]
  /** 确认广播回调 */
  onConfirm: () => void
  /** 取消/关闭回调 */
  onCancel: () => void
}

/** 广播确认弹窗 —— 普通态展示命令与目标列表二次确认；
 *  敏感态用危险色高亮并要求输入 yes 才能放行。镜像 AlertModal 的遮罩 + pop-in 样式。 */
export function BroadcastConfirmModal({ cmd, targets, sensitive, reasons, onConfirm, onCancel }: BroadcastConfirmModalProps) {
  const { t } = useTranslation()
  // 敏感态需输入 yes（去空格、忽略大小写）后才放行
  const [typed, setTyped] = useState('')
  const yesOk = typed.trim().toLowerCase() === 'yes'
  const confirmEnabled = !sensitive || yesOk

  // 危险色 / 常态色切换
  const accentFg = sensitive ? 'var(--danger-fg)' : 'var(--accent-primary)'
  const accentSoft = sensitive ? 'var(--danger-soft)' : 'var(--accent-soft)'
  const accentBorder = sensitive ? 'var(--danger-border)' : 'var(--border-hairline)'

  return (
    <div
      onClick={onCancel}
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
          width: 460,
          maxWidth: 'calc(100vw - 48px)',
          background: 'var(--surface-card)',
          borderRadius: 18,
          // 敏感态用危险色描边强警告
          border: `1px solid ${sensitive ? 'var(--danger-border)' : 'var(--border-hairline)'}`,
          boxShadow: 'var(--shadow-window)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* 标题栏 —— 敏感态切换标题文案与色彩 */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <span className="row gap8" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px', color: sensitive ? 'var(--danger-fg)' : undefined }}>
            {sensitive && <Icon name="alert-triangle" size={16} />}
            {sensitive ? t('workbench.broadcastDangerTitle') : t('workbench.broadcastConfirmTitle')}
          </span>
          <IconBtn name="x" size={16} variant="bare" onClick={onCancel} />
        </div>

        {/* 主体 */}
        <div className="col" style={{ gap: 14, padding: '16px 20px 18px' }}>
          {/* 描述 */}
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {t('workbench.broadcastConfirmDesc', { count: targets.length })}
          </span>

          {/* 将执行的命令 —— mono 代码块 */}
          <div className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('workbench.broadcastConfirmCmd')}</span>
            <div
              className="mono"
              style={{
                fontSize: 12.5,
                lineHeight: 1.5,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border-hairline)',
                color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 120,
                overflowY: 'auto',
              }}
            >
              {cmd}
            </div>
          </div>

          {/* 目标主机 chip 列表 */}
          <div className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('workbench.broadcastConfirmTargets')}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, maxHeight: 96, overflowY: 'auto' }}>
              {targets.map(tg => (
                <span
                  key={tg.id}
                  className="chip ell"
                  style={{ height: 24, maxWidth: '100%', fontSize: 11.5, background: 'var(--surface-sunken)', color: 'var(--text-secondary)' }}
                  title={tg.name}
                >
                  <Icon name="server" size={11} /> {tg.name}
                </span>
              ))}
            </div>
          </div>

          {/* 敏感态：风险说明 + 二次确认输入 */}
          {sensitive && (
            <div
              className="col"
              style={{ gap: 10, padding: '12px 14px', borderRadius: 12, background: accentSoft, border: `1px solid ${accentBorder}` }}
            >
              <span className="row gap8" style={{ fontSize: 12.5, fontWeight: 700, color: accentFg }}>
                <Icon name="alert-triangle" size={14} /> {t('workbench.broadcastDangerHint')}
              </span>
              <ul className="col" style={{ gap: 5, margin: 0, paddingLeft: 18 }}>
                {reasons.map(code => (
                  <li key={code} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {t('workbench.broadcastRisk.' + code)}
                  </li>
                ))}
              </ul>
              <input
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder={t('workbench.broadcastTypeYes')}
                autoFocus
                style={{
                  height: 34,
                  padding: '0 12px',
                  borderRadius: 9,
                  fontSize: 13,
                  background: 'var(--surface-card)',
                  border: `1px solid ${yesOk ? 'var(--accent-primary)' : accentBorder}`,
                  color: 'var(--text-primary)',
                  outline: 'none',
                }}
              />
            </div>
          )}

          {/* 操作区 */}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
            <Btn variant="ghost" onClick={onCancel}>{t('workbench.broadcastCancel')}</Btn>
            <Btn
              variant={sensitive ? 'danger' : 'primary'}
              icon="radar"
              onClick={onConfirm}
              disabled={!confirmEnabled}
              style={!confirmEnabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            >
              {t('workbench.broadcastConfirmBtn')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
