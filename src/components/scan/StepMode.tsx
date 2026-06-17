/* 资产发现向导 · 步骤① 选模式（主机 / 数据库），数据库模式展开引擎多选 */
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn } from '../atoms'
import { enginesByGroup } from '../../services/dbEngines'
import type { ScanMode } from '../../services/scan'
import type { StepModeProps } from './types'

// 模式大卡片：选中态用 accent 描边 + 浅色背景。
function ModeCard({
  active, icon, title, desc, onClick,
}: { active: boolean; icon: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-active={active ? '1' : undefined}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
        padding: 18,
        textAlign: 'left',
        borderRadius: 12,
        cursor: 'pointer',
        background: active ? 'color-mix(in srgb, var(--accent-primary) 10%, var(--surface-card))' : 'var(--surface-card)',
        border: active
          ? '1px solid color-mix(in srgb, var(--accent-primary) 60%, transparent)'
          : '1px solid var(--border-hairline)',
        boxShadow: active ? 'var(--shadow-card)' : 'none',
        transition: 'all .14s',
      }}
    >
      <div
        className="icon-badge"
        style={{
          width: 40, height: 40, borderRadius: 10,
          color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
          background: active ? 'color-mix(in srgb, var(--accent-primary) 16%, transparent)' : 'var(--surface-sunken)',
        }}
      >
        <Icon name={icon} size={20} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{desc}</div>
    </button>
  )
}

// 引擎勾选标签：选中态 accent 高亮 + check 图标。
function EngineChip({
  active, label, onClick,
}: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-active={active ? '1' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
        background: active ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'var(--surface-sunken)',
        border: active
          ? '1px solid color-mix(in srgb, var(--accent-primary) 50%, transparent)'
          : '1px solid var(--border-hairline)',
        transition: 'all .12s',
      }}
    >
      {active && <Icon name="check" size={13} />}
      {label}
    </button>
  )
}

export function StepMode({ mode, onModeChange, selectedEngineIds, onToggleEngine, onNext }: StepModeProps) {
  const { t } = useTranslation()

  const handleMode = (m: ScanMode) => onModeChange(m)

  // 下一步可用：host 模式直接可，db 模式须至少选 1 个引擎。
  const canNext = mode === 'host' || (mode === 'db' && selectedEngineIds.length > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 二选一模式卡片 */}
      <div style={{ display: 'flex', gap: 12 }}>
        <ModeCard
          active={mode === 'host'}
          icon="server"
          title={t('scan.mode.host')}
          desc={t('scan.mode.hostDesc')}
          onClick={() => handleMode('host')}
        />
        <ModeCard
          active={mode === 'db'}
          icon="database"
          title={t('scan.mode.db')}
          desc={t('scan.mode.dbDesc')}
          onClick={() => handleMode('db')}
        />
      </div>

      {/* 数据库模式：展开引擎多选 */}
      {mode === 'db' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, animation: 'growUp .18s ease' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {t('scan.mode.pickEngines')}
          </div>
          {enginesByGroup().map(({ group, engines }) => (
            <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.02em', color: 'var(--text-faint)' }}>
                {t('modals.engineGroup.' + group)}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {engines.map(e => (
                  <EngineChip
                    key={e.id}
                    active={selectedEngineIds.includes(e.id)}
                    label={e.label}
                    onClick={() => onToggleEngine(e.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部：下一步 */}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Btn variant="primary" iconR="chevron-right" onClick={onNext} disabled={!canNext}>
          {t('scan.next')}
        </Btn>
      </div>
    </div>
  )
}

export default StepMode
