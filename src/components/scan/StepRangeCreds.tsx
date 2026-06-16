import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, Chip } from '../atoms'
import type { StepRangeCredsProps } from './types'

// 字段标签：复用 NewConnectionModal 的标签样式（11.5px / 600 / text-tertiary）
const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }
// 受控文本域/输入框统一样式（匹配现有表单风格）
const fieldStyle: React.CSSProperties = {
  borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)',
  fontSize: 13, color: 'var(--text-primary)', outline: 'none', padding: '10px 12px', resize: 'vertical',
}
const inputStyle: React.CSSProperties = {
  height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)',
  background: 'var(--surface-sunken)', fontSize: 13, color: 'var(--text-primary)', outline: 'none',
}
const hintStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)' }

/** 步骤②：扫描范围 + 端口/凭证/密钥/并发配置（全部受控，回调交父容器处理） */
export function StepRangeCreds(props: StepRangeCredsProps) {
  const {
    mode, ranges, onRangesChange, customPorts, onCustomPortsChange,
    dictText, onDictTextChange, keyFiles, onAddKeyFiles, onRemoveKeyFile,
    keyUsersRaw, onKeyUsersChange, concurrency, onConcurrencyChange,
    defaultPorts, onBack, onStart,
  } = props
  const { t } = useTranslation()

  // 上传字典文件：plugin-dialog 多选文本（沿用 jdbcDrivers.ts 的“选路径 → 交 Rust 读取”模式），
  // 读到的内容追加到现有 dictText，经 onDictTextChange 回填父级状态。
  // 文件 IO 走后端命令 scan_read_text_file（path -> 文本），非 Tauri 环境静默忽略。
  async function handleDictUpload() {
    try {
      const isTauri = typeof window !== 'undefined'
        && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
      if (!isTauri) return
      const { open } = await import('@tauri-apps/plugin-dialog')
      const { invoke } = await import('@tauri-apps/api/core')
      const picked = await open({
        multiple: true,
        filters: [{ name: 'Dictionary', extensions: ['txt', 'lst', 'dic', 'csv'] }],
      })
      if (!picked) return // 用户取消
      const paths = (Array.isArray(picked) ? picked : [picked]).map(
        p => (typeof p === 'string' ? p : (p as { path: string }).path),
      )
      const texts: string[] = []
      for (const path of paths) texts.push(await invoke<string>('scan_read_text_file', { path }))
      const appended = texts.join('\n').trim()
      if (!appended) return
      onDictTextChange(dictText ? `${dictText.replace(/\s*$/, '')}\n${appended}` : appended)
    } catch {
      // 读取失败静默忽略
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* 顶部固定风险提示条 */}
      <div className="row gap8" style={{
        alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10,
        background: 'var(--danger-soft)', border: '1px solid var(--danger-border)',
      }}>
        <Icon name="alert-triangle" size={15} style={{ color: 'var(--signal-amber)', flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('scan.riskNotice')}</span>
      </div>

      {/* 扫描范围 */}
      <label className="col" style={{ gap: 5 }}>
        <span style={labelStyle}>{t('scan.range.label')}</span>
        <textarea
          value={ranges}
          onChange={e => onRangesChange(e.target.value)}
          placeholder={t('scan.range.placeholder')}
          className="mono"
          rows={3}
          style={fieldStyle}
        />
        <span style={hintStyle}>{t('scan.range.hint')}</span>
      </label>

      {/* 端口：默认（只读展示）+ 自定义 */}
      <label className="col" style={{ gap: 5 }}>
        <span style={labelStyle}>{t('scan.ports.label')}</span>
        <div className="row gap8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={hintStyle}>{t('scan.ports.defaultLabel')}</span>
          {defaultPorts.map(p => (
            <Chip key={p} mono>{p}</Chip>
          ))}
        </div>
        <input
          value={customPorts}
          onChange={e => onCustomPortsChange(e.target.value)}
          placeholder={t('scan.ports.placeholder')}
          className="mono"
          inputMode="numeric"
          style={inputStyle}
        />
      </label>

      {/* 凭证字典 */}
      <label className="col" style={{ gap: 5 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={labelStyle}>{t('scan.creds.label')}</span>
          <Btn size="sm" variant="ghost" icon="upload" onClick={handleDictUpload}>
            {t('scan.creds.upload')}
          </Btn>
        </div>
        <textarea
          value={dictText}
          onChange={e => onDictTextChange(e.target.value)}
          placeholder={t('scan.creds.placeholder')}
          className="mono"
          rows={4}
          style={fieldStyle}
        />
        <span style={hintStyle}>{t('scan.creds.hint')}</span>
      </label>

      {/* 密钥区：仅 host 模式 */}
      {mode === 'host' && (
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={labelStyle}>{t('scan.keys.label')}</span>
            <Btn size="sm" variant="ghost" icon="key" onClick={onAddKeyFiles}>
              {t('scan.keys.upload')}
            </Btn>
          </div>
          {keyFiles.length === 0 ? (
            <span style={hintStyle}>{t('scan.keys.empty')}</span>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {keyFiles.map(k => (
                <div key={k.path} className="row gap8" style={{
                  alignItems: 'center', justifyContent: 'space-between',
                  padding: '7px 10px', borderRadius: 10,
                  border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)',
                }}>
                  <div className="row gap8" style={{ alignItems: 'center', minWidth: 0 }}>
                    <Icon name="key" size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k.path}>{k.name}</span>
                  </div>
                  <button
                    className="icon-btn danger"
                    onClick={() => onRemoveKeyFile(k.path)}
                    title={k.path}
                    style={{ flexShrink: 0 }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="col" style={{ gap: 5 }}>
            <span style={labelStyle}>{t('scan.keys.users')}</span>
            <input
              value={keyUsersRaw}
              onChange={e => onKeyUsersChange(e.target.value)}
              placeholder={t('scan.keys.usersPlaceholder')}
              className="mono"
              style={inputStyle}
            />
          </label>
        </div>
      )}

      {/* 并发 */}
      <label className="col" style={{ gap: 5, maxWidth: 160 }}>
        <span style={labelStyle}>{t('scan.concurrency.label')}</span>
        <input
          value={String(concurrency)}
          onChange={e => {
            const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
            onConcurrencyChange(Number.isNaN(n) ? 0 : n)
          }}
          inputMode="numeric"
          className="mono"
          style={inputStyle}
        />
      </label>

      {/* 底部操作 */}
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <Btn variant="ghost" icon="chevron-left" onClick={onBack}>{t('scan.back')}</Btn>
        <Btn variant="primary" icon="radar" onClick={onStart}>{t('scan.start')}</Btn>
      </div>
    </div>
  )
}

export default StepRangeCreds
