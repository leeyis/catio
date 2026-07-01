/* ported from ref-ui/_extract/blob12.txt — verbatim per plan T1-T7 */
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { BrandMark } from '../BrandMark'
import { Btn, IconBtn, Toggle, Segmented } from '../atoms'
import { useLang } from '../../state/LanguageContext'
import { useAgentConfig, clearStoredCredentials } from '../../state/agentConfig'
import { forgetAllSecrets } from '../../state/vault'
import { ConfirmModal } from '../modals/ConfirmModal'
import { usePrefs, UI_FONTS, MONO_FONTS, TERM_FONT_SIZES, TERM_BUFFER_LINE_OPTIONS } from '../../state/preferences'
import type { UiFontKey, MonoFontKey, Density } from '../../state/preferences'
import { fetchModels, testModel } from '../../services'
import type { ModelTestResult } from '../../services'
import { isTauri } from '../../services/ssh'
import { mcpStart, mcpStop, mcpStatus, mcpSetWhitelist, mcpSetLiveLog, onMcpLog, onMcpServerLog, mcpTokenGet, mcpTokenRegenerate, mcpTokenSetEnabled } from '../../services/mcp'
import type { McpInfo, McpLogEntry } from '../../services/mcp'
import { exportConfig, importConfig } from '../../services/configSync'
import { ServerAccountBlock } from '../auth/ServerAccountBlock'
import { useServerAuth } from '../auth/ServerAuthGate'
import { isServer } from '../../services/transport'
import { copyTextToClipboard } from '../../services/clipboard'

// ---- Prop types ----

export interface User {
  username: string
  hint?: string
}

export interface SettingsViewProps {
  theme: string
  onTheme: (id: string) => void
  onClose: () => void
  /** Section to open to on mount (theme | appearance | security | ai | ...). */
  initialSection?: string
  authEnabled?: boolean
  users?: User[]
  currentUser?: string
  ownerUser?: string
  onEnableAuth?: () => void
  onDisableAuth?: () => void
  onLock?: () => void
  onRemoveUser?: (username: string) => void
  /** Import hosts from ~/.ssh/config; resolves with how many were added. */
  onImportSshConfig?: () => Promise<{ added: number; total: number }>
}

// ---- Subcomponent prop types ----

interface BlockProps {
  title: string
  hint?: string
  children: React.ReactNode
}

interface SettingRowProps {
  icon?: string
  title: string
  desc?: string
  control?: React.ReactNode
  danger?: boolean
}

interface ThemeSettingsProps {
  theme: string
  onTheme: (id: string) => void
}

interface SecuritySettingsProps {
  authEnabled?: boolean
  users?: User[]
  currentUser?: string
  ownerUser?: string
  onEnableAuth?: () => void
  onDisableAuth?: () => void
  onLock?: () => void
  onRemoveUser?: (username: string) => void
}

// ---- Theme & nav data ----

interface ThemeDef {
  id: string
  nameKey: string
  subKey: string
  swatches: string[]
}

const THEMES: ThemeDef[] = [
  { id: 'dawn', nameKey: 'settings.themeDawn', subKey: 'settings.themeDawnSub', swatches: ['#F5F6F8', '#FFFFFF', '#1b1bb9'] },
  { id: 'amber', nameKey: 'settings.themeAmber', subKey: 'settings.themeAmberSub', swatches: ['#18140F', '#221E18', '#D4A574'] },
  { id: 'grove', nameKey: 'settings.themeGrove', subKey: 'settings.themeGroveSub', swatches: ['#050A07', '#0B1410', '#4ADE80'] },
]

interface NavItem {
  id: string
  icon: string
  labelKey: string
}

const SETTINGS_NAV: NavItem[] = [
  // Theme + appearance merged into one "外观" tab (palette icon).
  { id: 'appearance', icon: 'palette', labelKey: 'settings.navAppearance' },
  { id: 'security', icon: 'shield', labelKey: 'settings.navSecurity' },
  { id: 'ai', icon: 'wand', labelKey: 'settings.navAi' },
  { id: 'connections', icon: 'plug', labelKey: 'settings.navConnections' },
  { id: 'mcp', icon: 'command', labelKey: 'settings.navMcp' },
  { id: 'about', icon: 'info', labelKey: 'settings.navAbout' },
]

// ---- Helper components ----

function Block({ title, hint, children }: BlockProps) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="col" style={{ marginBottom: 14, gap: 3 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px' }}>{title}</h2>
        {hint && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function SettingRow({ icon, title, desc, control, danger }: SettingRowProps) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 16, padding: '14px 16px', border: '1px solid var(--border-hairline)', borderRadius: 14, background: 'var(--surface-card)', marginBottom: 8 }}>
      <div className="row gap12">
        {icon && <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 10, color: danger ? 'var(--danger-fg)' : 'var(--text-tertiary)' }}><Icon name={icon} size={16} /></div>}
        <div className="col" style={{ lineHeight: 1.4 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
          {desc && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{desc}</span>}
        </div>
      </div>
      {control}
    </div>
  )
}

function ThemeSettings({ theme, onTheme }: ThemeSettingsProps) {
  const { t } = useTranslation()
  return (
    <Block title={t('settings.themeTitle')}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        {THEMES.map(th => {
          const active = theme === th.id
          return (
            <button key={th.id} onClick={() => onTheme(th.id)}
              style={{ textAlign: 'left', padding: 16, borderRadius: 14, background: 'var(--surface-card)', border: active ? '2px solid var(--accent-primary)' : '1px solid var(--border-hairline)', boxShadow: active ? 'var(--glow-selected)' : 'var(--shadow-card)', transition: 'all .14s' }}>
              <div className="row gap6" style={{ marginBottom: 12 }}>
                {th.swatches.map((s, i) => <span key={i} style={{ width: 22, height: 22, borderRadius: 6, background: s, border: '1px solid rgba(127,127,127,0.25)' }} />)}
              </div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{t(th.nameKey)}</span>
                {active && <span className="badge-accent"><Icon name="check" size={10} /> {t('settings.themeCurrentBadge')}</span>}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t(th.subKey)}</span>
            </button>
          )
        })}
      </div>
    </Block>
  )
}

// Compact −/＋ stepper for discrete numeric prefs (e.g. terminal font size).
function Stepper({ value, onDec, onInc, atMin, atMax }: { value: string; onDec: () => void; onInc: () => void; atMin: boolean; atMax: boolean }) {
  const btn: React.CSSProperties = { width: 28, height: 28, borderRadius: 8, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1, display: 'grid', placeItems: 'center' }
  return (
    <div className="row gap6" style={{ alignItems: 'center' }}>
      <button style={{ ...btn, opacity: atMin ? 0.4 : 1, cursor: atMin ? 'default' : 'pointer' }} disabled={atMin} onClick={onDec}>−</button>
      <span className="chip mono" style={{ minWidth: 58, justifyContent: 'center' }}>{value}</span>
      <button style={{ ...btn, opacity: atMax ? 0.4 : 1, cursor: atMax ? 'default' : 'pointer' }} disabled={atMax} onClick={onInc}>＋</button>
    </div>
  )
}

function AppearanceSettings() {
  const { t } = useTranslation()
  const { lang, setLang } = useLang()
  const { prefs, update } = usePrefs()
  const sizes = TERM_FONT_SIZES
  const curIdx = Math.max(0, sizes.indexOf(prefs.termFontPx as typeof sizes[number]))
  const stepSize = (dir: number) => {
    const next = Math.min(sizes.length - 1, Math.max(0, curIdx + dir))
    update({ termFontPx: sizes[next] })
  }
  return (
    <Block title={t('settings.appearanceTitle')} hint={t('settings.appearanceHint')}>
      <SettingRow icon="type" title={t('settings.uiFont')} desc={t('settings.uiFontDesc')}
        control={<Segmented value={prefs.uiFont} onChange={v => update({ uiFont: v as UiFontKey })} options={UI_FONTS.map(f => ({ value: f.key, label: f.label }))} />} />
      <SettingRow icon="code" title={t('settings.monoFont')} desc={t('settings.monoFontDesc')}
        control={<Segmented value={prefs.monoFont} onChange={v => update({ monoFont: v as MonoFontKey })} options={MONO_FONTS.map(f => ({ value: f.key, label: f.label }))} />} />
      <SettingRow icon="terminal" title={t('settings.termFontSize')} desc={t('settings.termFontSizeDesc')}
        control={<Stepper value={`${prefs.termFontPx} px`} onDec={() => stepSize(-1)} onInc={() => stepSize(1)} atMin={curIdx === 0} atMax={curIdx === sizes.length - 1} />} />
      <SettingRow icon="sliders" title={t('settings.density')} desc={t('settings.densityDesc')}
        control={<Segmented value={prefs.density} onChange={v => update({ density: v as Density })} options={[{ value: 'comfortable', label: t('settings.densityComfortable') }, { value: 'compact', label: t('settings.densityCompact') }]} />} />
      <SettingRow
        icon="globe"
        title={t('settings.language')}
        control={
          <Segmented
            value={lang}
            onChange={v => setLang(v as 'zh' | 'en')}
            options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]}
          />
        }
      />
    </Block>
  )
}

function SecuritySettings({ authEnabled, users = [], currentUser, ownerUser, onEnableAuth, onDisableAuth, onLock, onRemoveUser }: SecuritySettingsProps) {
  const { t } = useTranslation()
  const [confirmClear, setConfirmClear] = useState(false)
  const [cleared, setCleared] = useState(false)
  return (
    <Block title={t('settings.securityTitle')} hint={t('settings.securityHint')}>
      {/* server-deploy account + user management (renders nothing in the desktop app) */}
      <ServerAccountBlock />
      {/* multi-user identity gate — DESKTOP only: in server mode the server session already IS the
          identity, so this local-login toggle is meaningless and is hidden. */}
      {!isServer() && (
      <div style={{ border: `1px solid ${authEnabled ? 'var(--accent-border)' : 'var(--border-hairline)'}`, borderRadius: 14, overflow: 'hidden', marginBottom: 16, background: authEnabled ? 'var(--accent-soft-alt)' : 'var(--surface-card)' }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 16, padding: '14px 16px' }}>
          <div className="row gap12">
            <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--surface-card)', color: authEnabled ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}><Icon name="shield" size={17} /></div>
            <div className="col" style={{ lineHeight: 1.4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('settings.authLabel')}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)', maxWidth: 360 }}>{t('settings.authDesc')}</span>
            </div>
          </div>
          <Toggle on={!!authEnabled} accent onChange={(v) => v ? onEnableAuth && onEnableAuth() : onDisableAuth && onDisableAuth()} />
        </div>
        {authEnabled && (
          <div className="col" style={{ borderTop: '1px solid var(--accent-border)', padding: '12px 16px', gap: 10 }}>
            {/* user list */}
            <div className="col gap6">
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('settings.localAccountsLabel', { count: users.length })}</span>
              {users.map(x => (
                <div key={x.username} className="row gap10" style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)' }}>
                  <div className="icon-badge" style={{ width: 30, height: 30, borderRadius: 9, background: x.username === currentUser ? 'var(--accent-soft)' : 'var(--surface-sunken)', color: x.username === currentUser ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}><Icon name="user" size={15} /></div>
                  <div className="col grow" style={{ lineHeight: 1.3, minWidth: 0 }}>
                    <span className="row gap6" style={{ minWidth: 0 }}>
                      <span className="ell" style={{ fontSize: 13, fontWeight: 600 }}>{x.username}</span>
                      {x.username === currentUser && <span className="badge-accent">{t('settings.currentUserBadge')}</span>}
                      {x.username === ownerUser && <span className="chip" style={{ height: 18, fontSize: 9.5 }}><Icon name="star" size={9} /> {t('settings.ownerBadge')}</span>}
                    </span>
                    <span className="ell" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('settings.hintPrefix')}{x.hint || t('settings.hintUnset')}</span>
                  </div>
                  {x.username !== currentUser && <button className="icon-btn danger" style={{ width: 28, height: 28, background: 'var(--danger-soft)', color: 'var(--danger-fg)' }} title={t('settings.removeUserTitle')} onClick={() => onRemoveUser && onRemoveUser(x.username)}><Icon name="trash-2" size={14} /></button>}
                </div>
              ))}
            </div>
            <div className="row gap8">
              <Btn variant="secondary" size="sm" icon="lock" onClick={onLock}>{t('settings.lockBtn')}</Btn>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', alignSelf: 'center' }}>{t('settings.lockHint')}</span>
            </div>
          </div>
        )}
      </div>
      )}

      <SettingRow icon="trash-2" title={t('settings.clearCredentials')} desc={t('settings.clearCredentialsDesc')} danger
        control={<Btn variant="danger" size="sm" onClick={() => setConfirmClear(true)}>{t('settings.clearBtn')}</Btn>} />
      {cleared && (
        <div className="row gap6" style={{ marginTop: 2, fontSize: 11.5, color: 'var(--signal-green)' }}>
          <Icon name="check" size={12} /> {t('settings.clearedNote')}
        </div>
      )}
      {confirmClear && (
        <ConfirmModal
          title={t('settings.clearConfirmTitle')}
          message={t('settings.clearConfirmMsg')}
          confirmLabel={t('settings.clearBtn')}
          danger
          onConfirm={() => { clearStoredCredentials(); forgetAllSecrets(); setConfirmClear(false); setCleared(true) }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </Block>
  )
}

// ---- Agent config block ----

function AgentConfigBlock() {
  const { t } = useTranslation()
  const { config, update } = useAgentConfig()
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null)
  const modelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!modelOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [modelOpen])

  async function handleFetch() {
    setLoading(true)
    setFetchError('')
    try {
      const list = await fetchModels(config)
      setModels(list)
      if (!config.model && list.length > 0) {
        update({ model: list[0] })
      }
    } catch (err) {
      setFetchError(t('settings.agentFetchError'))
    } finally {
      setLoading(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    const result = await testModel(config)
    setTestResult(result)
    setTesting(false)
  }

  const inputStyle: React.CSSProperties = {
    height: 36,
    padding: '0 12px',
    borderRadius: 10,
    border: '1px solid var(--border-hairline-alt)',
    background: 'var(--surface-sunken)',
    fontSize: 13,
    color: 'var(--text-primary)',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    marginBottom: 5,
    display: 'block',
  }

  const rowWrapStyle: React.CSSProperties = {
    padding: '14px 16px',
    border: '1px solid var(--border-hairline)',
    borderRadius: 14,
    background: 'var(--surface-card)',
    marginBottom: 8,
  }

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Provider */}
      <div style={rowWrapStyle}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="row gap12">
            <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 10, color: 'var(--text-tertiary)' }}>
              <Icon name="wand" size={16} />
            </div>
            <div className="col" style={{ lineHeight: 1.4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('settings.agentProvider')}</span>
            </div>
          </div>
          <Segmented
            value={config.provider}
            onChange={v => update({ provider: v as 'ollama' | 'openai' })}
            options={[
              { value: 'ollama', label: t('settings.agentProviderOllama') },
              { value: 'openai', label: t('settings.agentProviderOpenai') },
            ]}
          />
        </div>
      </div>

      {/* Endpoint URL */}
      <div style={rowWrapStyle}>
        <label className="col" style={{ gap: 5 }}>
          <span style={labelStyle}>{t('settings.agentEndpointUrl')}</span>
          <input
            style={inputStyle}
            value={config.provider === 'ollama' ? config.ollamaBaseUrl : config.openaiBaseUrl}
            onChange={e => {
              if (config.provider === 'ollama') {
                update({ ollamaBaseUrl: e.target.value })
              } else {
                update({ openaiBaseUrl: e.target.value })
              }
            }}
            placeholder={config.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com'}
          />
        </label>
      </div>

      {/* API Key — only for openai */}
      {config.provider === 'openai' && (
        <div style={rowWrapStyle}>
          <label className="col" style={{ gap: 5 }}>
            <span style={labelStyle}>{t('settings.agentApiKey')}</span>
            <div className="row" style={{ height: 36, borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', paddingLeft: 10, paddingRight: 12, gap: 6, alignItems: 'center' }}>
              <Icon name="lock" size={12} style={{ color: 'var(--text-faint)', flex: 'none' }} />
              <input
                type="password"
                value={config.openaiKey}
                onChange={e => update({ openaiKey: e.target.value })}
                placeholder={t('settings.agentApiKeyPlaceholder')}
                style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }}
              />
            </div>
          </label>
        </div>
      )}

      {/* Model picker + fetch button */}
      <div style={rowWrapStyle}>
        <span style={labelStyle}>{t('settings.agentModelLabel')}</span>
        <div className="row gap8" style={{ alignItems: 'flex-start' }}>
          {/* Dropdown */}
          <div ref={modelRef} style={{ position: 'relative', flex: 1 }}>
            <button
              onClick={() => setModelOpen(o => !o)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ flex: 1, fontSize: 13, color: config.model ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                {config.model || t('settings.agentSelectModel')}
              </span>
              <Icon name="chevron-down" size={14} style={{ color: 'var(--text-faint)', transform: modelOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .14s' }} />
            </button>
            {modelOpen && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 80, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', maxHeight: 260, overflowY: 'auto' }}>
                {models.length === 0 ? (
                  <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-faint)' }}>{t('settings.agentNoModels')}</div>
                ) : (
                  models.map(m => {
                    const active = config.model === m
                    return (
                      <button key={m}
                        onClick={() => { update({ model: m }); setModelOpen(false) }}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}
                      >
                        <span style={{ flex: 1, fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{m}</span>
                        {active && <Icon name="check" size={13} style={{ color: 'var(--accent-primary)' }} />}
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
          {/* Fetch button */}
          <Btn
            variant="secondary"
            size="sm"
            icon={loading ? 'loader' : 'refresh-cw'}
            disabled={loading}
            onClick={() => { void handleFetch() }}
          >
            {loading ? t('settings.agentFetching') : t('settings.agentFetchModels')}
          </Btn>
          {/* Test button */}
          <Btn
            variant="secondary"
            size="sm"
            icon={testing ? 'loader' : 'zap'}
            disabled={testing}
            onClick={() => { void handleTest() }}
          >
            {testing ? t('settings.agentTesting') : t('settings.agentTestModel')}
          </Btn>
        </div>
        {/* Inline fetch error */}
        {fetchError && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--danger-fg)' }}>
            {fetchError}
          </div>
        )}
        {/* Test result */}
        {testResult !== null && (
          <div style={{ marginTop: 8, fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5, color: testResult.ok ? 'var(--signal-green)' : 'var(--danger-fg)' }}>
            {testResult.ok ? (
              <>
                <Icon name="check" size={12} />
                <span>
                  {t('settings.agentTestOk', { ms: testResult.latencyMs })}
                  {testResult.reply ? ` · "${testResult.reply.slice(0, 40)}"` : ''}
                </span>
              </>
            ) : (
              <>
                <Icon name="zap" size={12} />
                <span>
                  {testResult.error === 'no-model'
                    ? t('settings.agentSelectModelFirst')
                    : `${t('settings.agentTestFail')}: ${testResult.error ?? ''}`}
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function AISettings() {
  const { t } = useTranslation()
  const { prefs, update } = usePrefs()
  const opts = TERM_BUFFER_LINE_OPTIONS
  const lineIdx = Math.max(0, opts.indexOf(prefs.termBufferLines as typeof opts[number]))
  const stepLines = (dir: number) => {
    const next = Math.min(opts.length - 1, Math.max(0, lineIdx + dir))
    update({ termBufferLines: opts[next] })
  }
  return (
    <Block title={t('settings.aiSettingsTitle')} hint={t('settings.aiSettingsHint')}>
      <AgentConfigBlock />
      <SettingRow icon="terminal" title={t('settings.aiTermBuffer')} desc={t('settings.aiTermBufferDesc', { count: prefs.termBufferLines })}
        control={
          <div className="row gap8" style={{ alignItems: 'center' }}>
            {prefs.termBufferEnabled && (
              <Stepper value={t('settings.aiTermBufferLines', { count: prefs.termBufferLines })}
                onDec={() => stepLines(-1)} onInc={() => stepLines(1)} atMin={lineIdx === 0} atMax={lineIdx === opts.length - 1} />
            )}
            <Toggle on={prefs.termBufferEnabled} onChange={v => update({ termBufferEnabled: v })} />
          </div>
        } />
    </Block>
  )
}

function ConnDefaults({ onImportSshConfig }: { onImportSshConfig?: () => Promise<{ added: number; total: number }> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'none' | 'error'; text: string } | null>(null)

  async function handleImport() {
    if (!onImportSshConfig || busy) return
    setBusy(true)
    setResult(null)
    try {
      const { added, total } = await onImportSshConfig()
      if (total === 0) setResult({ kind: 'none', text: t('settings.importNone') })
      else setResult({ kind: 'ok', text: t('settings.importResult', { added, total }) })
    } catch (err) {
      const message = (err as { message?: string } | null)?.message ?? String(err)
      setResult({ kind: 'error', text: t('settings.importError', { message }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Block title={t('settings.connDefaultsTitle')} hint={t('settings.connDefaultsHint')}>
      <SettingRow icon="git-branch" title={t('settings.importSshConfig')} desc={t('settings.importSshConfigDesc')}
        control={<Btn variant="secondary" size="sm" icon={busy ? 'loader' : 'download'} disabled={busy} onClick={() => { void handleImport() }}>{busy ? t('settings.importing') : t('settings.importBtn')}</Btn>} />
      {result && (
        <div className="row gap6" style={{ marginTop: 2, fontSize: 11.5, color: result.kind === 'error' ? 'var(--danger-fg)' : result.kind === 'none' ? 'var(--text-faint)' : 'var(--signal-green)' }}>
          {result.kind !== 'error' && result.kind === 'ok' && <Icon name="check" size={12} />}
          <span>{result.text}</span>
        </div>
      )}
    </Block>
  )
}

// Encrypted config export/import (B3) — move connections + settings across devices.
function ConfigSyncBlock() {
  const { t } = useTranslation()
  const [expPass, setExpPass] = useState('')
  const [bundle, setBundle] = useState('')
  const [impPass, setImpPass] = useState('')
  const [impText, setImpText] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function doExport() {
    if (!expPass || busy) return
    setBusy(true); setStatus(null)
    try { setBundle(await exportConfig(expPass)) }
    catch (e) { setStatus({ kind: 'error', text: String((e as { message?: string } | null)?.message ?? e) }) }
    finally { setBusy(false) }
  }
  function copyBundle() { if (bundle) copyTextToClipboard(bundle) }
  async function doImport() {
    if (!impPass || !impText.trim() || busy) return
    setBusy(true); setStatus(null)
    try {
      const r = await importConfig(impText, impPass)
      setStatus({ kind: 'ok', text: t('settings.syncImported', { count: r.keys }) })
      setTimeout(() => window.location.reload(), 900)
    } catch (e) { setStatus({ kind: 'error', text: String((e as { message?: string } | null)?.message ?? e) }) }
    finally { setBusy(false) }
  }

  const inputStyle: React.CSSProperties = { height: 34, padding: '0 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }
  const taStyle: React.CSSProperties = { ...inputStyle, height: 80, padding: '8px 10px', resize: 'vertical', fontFamily: 'monospace', fontSize: 11, width: '100%' }

  return (
    <Block title={t('settings.syncTitle')} hint={t('settings.syncHint')}>
      <div className="col" style={{ gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('settings.syncExport')}</span>
        <div className="row gap8" style={{ alignItems: 'center' }}>
          <input type="password" placeholder={t('settings.syncPassphraseHint')} value={expPass} onChange={e => setExpPass(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <Btn variant="secondary" size="sm" icon="lock" disabled={expPass.length < 8 || busy} onClick={() => void doExport()}>{t('settings.syncExportBtn')}</Btn>
        </div>
        {bundle && (
          <div className="col" style={{ gap: 6 }}>
            <textarea readOnly value={bundle} style={taStyle} onFocus={e => e.currentTarget.select()} />
            <div className="row"><Btn variant="ghost" size="sm" icon="copy" onClick={copyBundle}>{t('settings.syncCopy')}</Btn></div>
          </div>
        )}
      </div>
      <div className="col" style={{ gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('settings.syncImport')}</span>
        <textarea placeholder={t('settings.syncImportPlaceholder')} value={impText} onChange={e => setImpText(e.target.value)} style={taStyle} />
        <div className="row gap8" style={{ alignItems: 'center' }}>
          <input type="password" placeholder={t('settings.syncPassphrase')} value={impPass} onChange={e => setImpPass(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <Btn variant="primary" size="sm" icon="download" disabled={!impPass || !impText.trim() || busy} onClick={() => void doImport()}>{t('settings.syncImportBtn')}</Btn>
        </div>
      </div>
      {status && (
        <div className="row gap6" style={{ marginTop: 10, fontSize: 11.5, color: status.kind === 'error' ? 'var(--danger-fg)' : 'var(--signal-green)' }}>
          {status.kind === 'ok' && <Icon name="check" size={12} />}<span>{status.text}</span>
        </div>
      )}
    </Block>
  )
}

// IPv4 single-address or a.b.c.d/n CIDR. Octets 0-255, prefix 0-32.
const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/

function isValidWhitelistEntry(s: string): boolean {
  const m = IPV4_CIDR_RE.exec(s)
  if (!m) return false
  for (let i = 1; i <= 4; i++) { if (Number(m[i]) > 255) return false }
  if (m[6] !== undefined) { const p = Number(m[6]); if (p < 0 || p > 32) return false }
  return true
}

// A rule is loopback-only when its address sits in 127.0.0.0/8.
function isLoopbackEntry(s: string): boolean {
  return s.split('/')[0].startsWith('127.')
}

// In-memory log row: the wire payload plus a stable client id for expand state.
type LogRow = McpLogEntry & { _id: number }

const LOG_RING = 200
const FIELD_TRUNC = 160

function logKindStyle(kind: string, isError?: boolean): { fg: string; bg: string } {
  if (kind === 'denied' || isError) return { fg: 'var(--danger-fg)', bg: 'color-mix(in srgb, var(--danger-fg) 13%, transparent)' }
  if (kind === 'tools/result') return { fg: 'var(--signal-green)', bg: 'color-mix(in srgb, var(--signal-green) 13%, transparent)' }
  if (kind === 'tools/call' || kind === 'connect') return { fg: 'var(--accent-primary)', bg: 'var(--accent-soft)' }
  if (kind === 'transfer') return { fg: 'var(--text-secondary)', bg: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' }
  return { fg: 'var(--text-tertiary)', bg: 'var(--surface-sunken)' }
}

// Human-readable byte size for the SFTP transfer progress bar (server-mode `transfer` rows).
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

// Shared live-log panel: a 200-entry ring buffer with pause/clear, click-to-expand args/output,
// and stale-key pruning. Both heads drive it through the `subscribe` prop:
//   - desktop passes a wrapper over onMcpLog (showUser=false) — its mcp://log payloads never set
//     userId/username/transfer, so the rendered output is identical to the pre-extraction panel.
//   - server passes (cb) => onMcpServerLog(scope, cb); an admin viewing `all` sets showUser to
//     render the username column, and SFTP `transfer` rows render a progress bar.
function McpLogPanel({ subscribe, showUser }: { subscribe: (cb: (e: McpLogEntry) => void) => Promise<() => void>; showUser?: boolean }) {
  const { t } = useTranslation()
  const [log, setLog] = useState<LogRow[]>([])
  const [paused, setPaused] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const idRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Subscribe while mounted; unsubscribe on unmount (or when `subscribe` identity changes, e.g. the
  // server head switching scope). The `active` guard drops a unsub that resolves after teardown.
  useEffect(() => {
    let active = true
    let un: (() => void) | undefined
    void subscribe(e => {
      setLog(prev => {
        const row: LogRow = { ...e, _id: idRef.current++ }
        const next = [...prev, row]
        return next.length > LOG_RING ? next.slice(next.length - LOG_RING) : next
      })
    }).then(u => { if (active) un = u; else u() })
    return () => { active = false; if (un) un() }
  }, [subscribe])

  // Autoscroll to the newest row unless the user paused.
  useEffect(() => {
    if (!paused && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [log, paused])

  // Drop expand state for rows evicted from the ring buffer so `expanded` can't accumulate stale keys.
  useEffect(() => {
    setExpanded(prev => {
      if (prev.size === 0) return prev
      const live = new Set(log.map(r => r._id))
      let changed = false
      const next = new Set<string>()
      prev.forEach(k => {
        if (live.has(Number(k.split(':')[0]))) next.add(k)
        else changed = true
      })
      return changed ? next : prev
    })
  }, [log])

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key); else n.add(key)
      return n
    })
  }

  function clearLog() {
    setLog([])
    setExpanded(new Set())
  }

  const linkBtnStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--accent-primary)', fontSize: 10.5, fontWeight: 600, cursor: 'pointer' }

  // One truncatable args/output block with click-to-expand.
  function logField(rowId: number, name: 'args' | 'output', label: string, value: string, isError?: boolean) {
    const key = `${rowId}:${name}`
    const open = expanded.has(key)
    const long = value.length > FIELD_TRUNC
    const shown = open || !long ? value : value.slice(0, FIELD_TRUNC) + '…'
    return (
      <div className="col gap4" style={{ marginTop: 6 }}>
        <div className="row gap6" style={{ alignItems: 'center' }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</span>
          {long && <button onClick={() => toggleExpand(key)} style={linkBtnStyle}>{open ? t('settings.mcpLogCollapse') : t('settings.mcpLogExpand')}</button>}
        </div>
        <code className="mono" style={{ padding: '6px 8px', background: 'var(--term-bg)', color: isError ? 'var(--danger-fg)' : 'var(--term-fg)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.45 }}>{shown}</code>
      </div>
    )
  }

  return (
    <div className="col" style={{ gap: 8, marginTop: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('settings.mcpLogPanelTitle')}</span>
        <div className="row gap6">
          <Btn variant="ghost" size="sm" icon={paused ? 'play' : 'square'} onClick={() => setPaused(p => !p)}>{paused ? t('settings.mcpLogResume') : t('settings.mcpLogPause')}</Btn>
          <Btn variant="ghost" size="sm" icon="broom" disabled={log.length === 0} onClick={clearLog}>{t('settings.mcpLogClear')}</Btn>
        </div>
      </div>

      <div ref={scrollRef} className="col" style={{ gap: 6, maxHeight: 320, overflowY: 'auto', padding: 8, border: '1px solid var(--border-hairline)', borderRadius: 10, background: 'var(--surface-sunken)' }}>
        {log.length === 0 ? (
          <div className="row gap6" style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: '8px 4px' }}>
            <Icon name="info" size={12} /> {t('settings.mcpLogEmpty')}
          </div>
        ) : (
          log.map(row => {
            const ks = logKindStyle(row.kind, row.isError)
            const argsStr = row.args !== undefined ? (typeof row.args === 'string' ? row.args : JSON.stringify(row.args)) : ''
            const isTransfer = row.kind === 'transfer'
            return (
              <div key={row._id} className="col" style={{ gap: 2, padding: '8px 10px', border: '1px solid var(--border-hairline)', borderRadius: 8, background: 'var(--surface-card)' }}>
                <div className="row gap6" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <code className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{row.ts.length >= 19 ? row.ts.slice(11, 19) : row.ts}</code>
                  <span className="chip" style={{ background: ks.bg, color: ks.fg, fontSize: 10 }}>{row.kind}</span>
                  {showUser && row.username && (
                    <span className="row gap4" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-faint)' }}>{t('settings.mcpLogUser')}</span>
                      <span className="mono" style={{ fontWeight: 600 }}>{row.username}</span>
                    </span>
                  )}
                  <span className="row gap4" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {row.ip && <span className="mono">{row.ip}</span>}
                    {row.sessionId && <span className="mono" style={{ color: 'var(--text-faint)' }}>· {row.sessionId}</span>}
                  </span>
                  {row.tool && (
                    <span className="row gap4" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-faint)' }}>{isTransfer ? t('settings.mcpLogTransfer') : t('settings.mcpLogTool')}</span>
                      <span className="mono" style={{ fontWeight: 600 }}>{row.tool}</span>
                    </span>
                  )}
                </div>
                {row.path && (
                  <code className="mono" style={{ fontSize: 11, color: 'var(--danger-fg)', marginTop: 4, wordBreak: 'break-all' }}>{row.path}</code>
                )}
                {row.transfer && (
                  <div className="col gap4" style={{ marginTop: 6 }}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                      <span className="mono">{fmtBytes(row.transfer.bytesTransferred)} / {fmtBytes(row.transfer.totalBytes)}</span>
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--accent-primary)' }}>{row.transfer.percent}%</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.max(0, Math.min(100, row.transfer.percent))}%`, height: '100%', background: 'var(--accent-primary)', transition: 'width .2s' }} />
                    </div>
                  </div>
                )}
                {argsStr && logField(row._id, 'args', t('settings.mcpLogArgs'), argsStr)}
                {row.output !== undefined && logField(row._id, 'output', row.isError ? t('settings.mcpLogError') : t('settings.mcpLogOutput'), row.output, row.isError)}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// Server mode exposes a per-user token-bearing SSE endpoint; desktop keeps the embedded
// start/stop/whitelist/live-log server. Dispatch on the runtime so each head renders its own UI
// (and only calls its own hooks).
function MCPSettings() {
  return isServer() ? <ServerMcpSettings /> : <DesktopMcpSettings />
}

// Server head: per-user MCP access. The user toggles their endpoint on/off, copies the
// token-bearing SSE URL into their MCP client, and can rotate the token. No start/stop/whitelist/
// live-log here — those are desktop-only embedded-server controls.
function ServerMcpSettings() {
  const { t } = useTranslation()
  const { user } = useServerAuth()
  const isAdmin = !!user?.isAdmin
  const [token, setToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)

  // Live-log section: default off/collapsed. Opening it subscribes to the user's own stream;
  // an admin can flip to the all-users stream. scope drives the topic the panel subscribes to.
  const [logOpen, setLogOpen] = useState(false)
  const [allUsers, setAllUsers] = useState(false)
  const scope: number | 'all' = allUsers && isAdmin ? 'all' : (user?.id ?? 0)
  const logSubscribe = useCallback((cb: (e: McpLogEntry) => void) => onMcpServerLog(scope, cb), [scope])

  // On mount: fetch (lazily minting) this user's token + enabled state.
  useEffect(() => {
    void mcpTokenGet().then(tk => { setToken(tk.token); setEnabled(tk.enabled) }).catch(() => {})
  }, [])

  // The token-bearing SSE endpoint, composed client-side from the page origin.
  const endpoint = token ? `${location.origin}/mcp/sse?token=${token}` : ''
  const claudeCmd = `claude mcp add --transport sse catio ${endpoint}`
  const clientJson = `{
  "mcpServers": {
    "catio": { "url": "${endpoint}" }
  }
}`

  async function toggleEnabled(on: boolean) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const r = await mcpTokenSetEnabled(on)
      setEnabled(r.enabled)
    } catch (err) {
      setError((err as { message?: string } | null)?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  async function regenerate() {
    setConfirmRegen(false)
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const tk = await mcpTokenRegenerate()
      setToken(tk.token)
      setEnabled(tk.enabled)
    } catch (err) {
      setError((err as { message?: string } | null)?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  function copy(text: string) {
    const ok = copyTextToClipboard(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const cardStyle: React.CSSProperties = { padding: 16, border: '1px solid var(--border-hairline)', borderRadius: 14, background: 'var(--surface-subtle)', marginBottom: 12 }

  return (
    <Block title={t('settings.mcpTitle')} hint={t('settings.mcpHint')}>
      <div style={cardStyle}>
        <div className="row gap8" style={{ marginBottom: 10 }}>
          <Icon name="command" size={15} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.mcpServerLabel')}</span>
          <span className="chip" style={{ marginLeft: 'auto', background: enabled ? 'color-mix(in srgb, var(--signal-green) 13%, transparent)' : 'var(--surface-sunken)', color: enabled ? 'var(--signal-green)' : 'var(--text-faint)' }}>
            <span className="dot" style={{ background: enabled ? 'var(--signal-green)' : 'var(--text-faint)' }} /> {enabled ? t('settings.mcpEnabled') : t('settings.mcpDisabled')}
          </span>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('settings.mcpServerDesc')}</p>

        <SettingRow
          icon="plug"
          title={t('settings.mcpEnableLabel')}
          desc={t('settings.mcpEnableDesc')}
          control={<Toggle on={enabled} onChange={on => { void toggleEnabled(on) }} accent />}
        />
        {error && <div className="row gap6" style={{ fontSize: 11.5, color: 'var(--danger-fg)', marginTop: 4 }}><Icon name="alert-triangle" size={12} /> {error}</div>}

        {enabled ? (
          <div className="col" style={{ gap: 8, marginTop: 12 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('settings.mcpServerEndpointHint')}</span>
            <div className="col gap4">
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('settings.mcpEndpoint')}</span>
              <div className="row gap6" style={{ alignItems: 'center' }}>
                <code className="mono" style={{ flex: 1, padding: '8px 10px', background: 'var(--term-bg)', color: 'var(--term-fg)', borderRadius: 8, fontSize: 11.5, overflow: 'auto' }}>{endpoint}</code>
                <Btn variant="secondary" size="sm" icon={copied ? 'check' : 'copy'} onClick={() => copy(endpoint)}>{copied ? t('settings.mcpCopied') : t('settings.mcpCopy')}</Btn>
              </div>
            </div>
            <div className="col gap4">
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('settings.mcpConfigHint')}</span>
              <pre className="mono" style={{ margin: 0, padding: '10px 12px', background: 'var(--term-bg)', color: 'var(--term-fg)', borderRadius: 8, fontSize: 11.5, overflow: 'auto' }}>{`# Claude Code\n${claudeCmd}\n\n# Cursor / Windsurf (mcp.json)\n${clientJson}`}</pre>
            </div>
          </div>
        ) : (
          <div className="row gap6" style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)' }}>
            <Icon name="info" size={12} /> {t('settings.mcpDisabledHint')}
          </div>
        )}

        <div className="col gap4" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-hairline)' }}>
          <div className="row gap8" style={{ alignItems: 'center' }}>
            <Btn variant="secondary" size="sm" icon="refresh-cw" disabled={busy || !token} onClick={() => setConfirmRegen(true)}>{t('settings.mcpRegenerate')}</Btn>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.4 }}>{t('settings.mcpRegenerateHint')}</span>
          </div>
        </div>
      </div>

      {/* Realtime log — closing the toggle unmounts the panel, which unsubscribes the WS topic. */}
      <div style={cardStyle}>
        <SettingRow
          icon="activity"
          title={t('settings.mcpServerLogLabel')}
          desc={t('settings.mcpServerLogDesc')}
          control={<Toggle on={logOpen} onChange={setLogOpen} accent />}
        />
        {logOpen && (
          <div className="col" style={{ gap: 8, marginTop: 4 }}>
            {isAdmin && (
              <SettingRow
                icon="globe"
                title={t('settings.mcpLogAllUsers')}
                desc={t('settings.mcpLogAllUsersDesc')}
                control={<Toggle on={allUsers} onChange={setAllUsers} accent />}
              />
            )}
            {/* key=scope remounts (fresh buffer + re-subscribe) when the admin flips own/all. */}
            <McpLogPanel key={String(scope)} subscribe={logSubscribe} showUser={allUsers && isAdmin} />
          </div>
        )}
      </div>

      <div className="row gap6" style={{ fontSize: 11, color: 'var(--text-faint)', padding: '0 2px' }}>
        <Icon name="shield" size={12} /> {t('settings.mcpServerTokenNote')}
      </div>

      {confirmRegen && (
        <ConfirmModal
          title={t('settings.mcpRegenerate')}
          message={t('settings.mcpRegenerateConfirm')}
          confirmLabel={t('settings.mcpRegenerate')}
          danger
          onConfirm={() => { void regenerate() }}
          onCancel={() => setConfirmRegen(false)}
        />
      )}
    </Block>
  )
}

// Desktop head: the embedded local MCP server with start/stop, IP whitelist, and live log.
function DesktopMcpSettings() {
  const { t } = useTranslation()
  const tauri = isTauri()
  const { prefs, update } = usePrefs()
  const [info, setInfo] = useState<McpInfo>({ running: false, url: null, port: null, exposed: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // Whitelist editor.
  const [wlInput, setWlInput] = useState('')
  const [wlError, setWlError] = useState('')
  const whitelist = prefs.mcpWhitelist
  const hasNonLoopback = whitelist.some(e => !isLoopbackEntry(e))

  // Live log: the shared McpLogPanel owns the ring buffer / pause / expand / prune. Desktop drives
  // it with onMcpLog and toggles the backend emit gate (mcpSetLiveLog) for the panel's lifetime —
  // on when it mounts (subscribe), off on cleanup (toggle-off OR unmount) — so the backend never
  // serializes events to a panel that isn't listening. showUser stays false (desktop is single-user).
  const liveLogSubscribe = useCallback((cb: (e: McpLogEntry) => void) => {
    void mcpSetLiveLog(true)
    return onMcpLog(cb).then(un => () => { un(); void mcpSetLiveLog(false) })
  }, [])

  // On mount: read status and push the persisted whitelist to the backend.
  useEffect(() => {
    void mcpStatus().then(setInfo).catch(() => {})
    void mcpSetWhitelist(prefs.mcpWhitelist)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleServer() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      let next: McpInfo
      if (info.running) {
        next = await mcpStop()
      } else {
        // Push the whitelist before binding so the listen address reflects it.
        await mcpSetWhitelist(prefs.mcpWhitelist)
        next = await mcpStart()
      }
      setInfo(next)
    } catch (err) {
      setError(t('settings.mcpStartError', { message: (err as { message?: string } | null)?.message ?? String(err) }))
    } finally {
      setBusy(false)
    }
  }

  function addWhitelist() {
    const v = wlInput.trim()
    if (!v || !isValidWhitelistEntry(v)) { setWlError(t('settings.mcpWhitelistInvalid')); return }
    if (whitelist.includes(v)) { setWlError(t('settings.mcpWhitelistDuplicate')); return }
    const next = [...whitelist, v]
    update({ mcpWhitelist: next })
    void mcpSetWhitelist(next)
    setWlInput('')
    setWlError('')
  }

  function removeWhitelist(entry: string) {
    const next = whitelist.filter(e => e !== entry)
    update({ mcpWhitelist: next })
    void mcpSetWhitelist(next)
  }

  function toggleLiveLog(on: boolean) {
    // McpLogPanel only mounts while prefs.mcpLiveLog is on, and its subscribe wrapper owns the
    // backend emit gate for that lifetime — so we just flip the pref here.
    update({ mcpLiveLog: on })
  }

  // The token-bearing SSE endpoint (only present while running).
  const url = info.url ?? ''
  const claudeCmd = `claude mcp add --transport sse catio ${url}`
  const clientJson = `{
  "mcpServers": {
    "catio": { "url": "${url}" }
  }
}`

  function copy(text: string) {
    const ok = copyTextToClipboard(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const cardStyle: React.CSSProperties = { padding: 16, border: '1px solid var(--border-hairline)', borderRadius: 14, background: 'var(--surface-subtle)', marginBottom: 12 }
  const wlInputStyle: React.CSSProperties = { height: 34, padding: '0 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-hairline-alt)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box', flex: 1 }

  return (
    <Block title={t('settings.mcpTitle')} hint={t('settings.mcpHint')}>
      <div style={cardStyle}>
        <div className="row gap8" style={{ marginBottom: 10 }}>
          <Icon name="command" size={15} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.mcpServerLabel')}</span>
          <span className="chip" style={{ marginLeft: 'auto', background: info.running ? 'color-mix(in srgb, var(--signal-green) 13%, transparent)' : 'var(--surface-sunken)', color: info.running ? 'var(--signal-green)' : 'var(--text-faint)' }}>
            <span className="dot" style={{ background: info.running ? 'var(--signal-green)' : 'var(--text-faint)' }} /> {info.running ? t('settings.mcpRunning') : t('settings.mcpStopped')}
          </span>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('settings.mcpDesc')}</p>

        {!tauri ? (
          <div className="row gap6" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            <Icon name="info" size={12} /> {t('settings.mcpDesktopOnly')}
          </div>
        ) : (
          <>
            <div className="row gap8" style={{ marginBottom: info.running ? 12 : 0 }}>
              <Btn variant={info.running ? 'secondary' : 'cta'} size="sm" icon={busy ? 'loader' : info.running ? 'square' : 'play'} disabled={busy} onClick={() => { void toggleServer() }}>
                {info.running ? t('settings.mcpStopBtn') : t('settings.mcpStartBtn')}
              </Btn>
              {error && <span style={{ fontSize: 11.5, color: 'var(--danger-fg)', alignSelf: 'center' }}>{error}</span>}
            </div>

            {info.running && (
              <div className="col" style={{ gap: 8 }}>
                <div className="col gap4">
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('settings.mcpEndpoint')}</span>
                  <div className="row gap6" style={{ alignItems: 'center' }}>
                    <code className="mono" style={{ flex: 1, padding: '8px 10px', background: 'var(--term-bg)', color: 'var(--term-fg)', borderRadius: 8, fontSize: 11.5, overflow: 'auto' }}>{url}</code>
                    <Btn variant="secondary" size="sm" icon={copied ? 'check' : 'copy'} onClick={() => copy(url)}>{copied ? t('settings.mcpCopied') : t('settings.mcpCopy')}</Btn>
                  </div>
                </div>
                <div className="col gap4">
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('settings.mcpConfigHint')}</span>
                  <pre className="mono" style={{ margin: 0, padding: '10px 12px', background: 'var(--term-bg)', color: 'var(--term-fg)', borderRadius: 8, fontSize: 11.5, overflow: 'auto' }}>{`# Claude Code\n${claudeCmd}\n\n# Cursor / Windsurf (mcp.json)\n${clientJson}`}</pre>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {tauri && (
        <>
          {/* IP whitelist manager */}
          <div style={cardStyle}>
            <div className="col gap4" style={{ marginBottom: 10 }}>
              <span className="row gap8" style={{ alignItems: 'center' }}>
                <Icon name="shield" size={15} style={{ color: 'var(--accent-primary)' }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.mcpWhitelistTitle')}</span>
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('settings.mcpWhitelistDesc')}</span>
            </div>

            <div className="row gap6" style={{ alignItems: 'center', marginBottom: wlError ? 6 : 10 }}>
              <input
                value={wlInput}
                placeholder={t('settings.mcpWhitelistPlaceholder')}
                onChange={e => { setWlInput(e.target.value); if (wlError) setWlError('') }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addWhitelist() } }}
                style={wlInputStyle}
              />
              <Btn variant="primary" size="sm" icon="plus" disabled={!wlInput.trim()} onClick={addWhitelist}>{t('settings.mcpWhitelistAdd')}</Btn>
            </div>
            {wlError && <div className="row gap6" style={{ fontSize: 11.5, color: 'var(--danger-fg)', marginBottom: 10 }}><Icon name="alert-triangle" size={12} /> {wlError}</div>}

            {whitelist.length === 0 ? (
              <div className="row gap6" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                <Icon name="info" size={12} /> {t('settings.mcpWhitelistEmpty')}
              </div>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {whitelist.map(entry => (
                  <div key={entry} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-hairline)', borderRadius: 10, background: 'var(--surface-card)' }}>
                    <code className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{entry}</code>
                    <Btn variant="ghost" size="sm" icon="trash-2" onClick={() => removeWhitelist(entry)}>{t('settings.mcpWhitelistRemove')}</Btn>
                  </div>
                ))}
              </div>
            )}

            {hasNonLoopback && (
              <div className="row gap6" style={{ marginTop: 12, padding: '8px 10px', borderRadius: 10, background: 'color-mix(in srgb, var(--danger-fg) 10%, transparent)', color: 'var(--danger-fg)', fontSize: 11.5, lineHeight: 1.5 }}>
                <Icon name="alert-triangle" size={13} style={{ flex: 'none', marginTop: 1 }} /> {t('settings.mcpExposeWarning')}
              </div>
            )}
            {info.running && (
              <div className="row gap6" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}>
                <Icon name="info" size={12} /> {t('settings.mcpRestartHint')}
              </div>
            )}
          </div>

          {/* Realtime log */}
          <div style={cardStyle}>
            <SettingRow
              icon="activity"
              title={t('settings.mcpLiveLogLabel')}
              desc={t('settings.mcpLiveLogDesc')}
              control={<Toggle on={prefs.mcpLiveLog} onChange={toggleLiveLog} accent />}
            />

            {prefs.mcpLiveLog && <McpLogPanel subscribe={liveLogSubscribe} />}
          </div>
        </>
      )}

      <div className="row gap6" style={{ fontSize: 11, color: 'var(--text-faint)', padding: '0 2px' }}>
        <Icon name="shield" size={12} /> {t('settings.mcpTokenNote')}
      </div>
    </Block>
  )
}

function AboutSettings() {
  const { t } = useTranslation()
  return (
    <Block title={t('settings.aboutTitle')}>
      <div className="row gap16" style={{ padding: 20, border: '1px solid var(--border-hairline)', borderRadius: 16, background: 'var(--surface-subtle)' }}>
        <BrandMark size={56} style={{ borderRadius: 18 }} />
        <div className="col" style={{ gap: 4 }}>
          <span className="row gap8" style={{ alignItems: 'baseline' }}>
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>Catio</span>
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-faint)' }}>v{__APP_VERSION__}</span>
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: 420 }}><Trans i18nKey="settings.aboutDesc" components={{ b: <b /> }} /></span>
        </div>
      </div>
    </Block>
  )
}

export function SettingsView({ theme, onTheme, onClose, authEnabled, users, currentUser, ownerUser, onEnableAuth, onDisableAuth, onLock, onRemoveUser, initialSection, onImportSshConfig }: SettingsViewProps) {
  const { t } = useTranslation()
  const serverAuth = useServerAuth()
  // 'theme' is folded into 'appearance' — normalise any legacy section id.
  const [nav, setNav] = React.useState(initialSection === 'theme' ? 'appearance' : (initialSection || 'appearance'))
  // Server mode: connection-defaults stay admin-only, but MCP access is per-user — every logged-in
  // user gets their own token-bearing endpoint, so the `mcp` item is shown to all of them.
  const navItems = SETTINGS_NAV.filter(n =>
    !(serverAuth.enabled && !serverAuth.user?.isAdmin && n.id === 'connections'),
  )
  return (
    <div className="body fade-in" style={{ flex: 1 }}>
      {/* left nav */}
      <div className="card-surface col" style={{ width: 220, flex: 'none', padding: '16px 10px' }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}>{t('settings.title')}</span>
          <IconBtn name="x" size={15} variant="bare" onClick={onClose} />
        </div>
        <div className="col" style={{ gap: 2 }}>
          {navItems.map(n => {
            const active = nav === n.id
            return (
              <button key={n.id} onClick={() => setNav(n.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 14px', borderRadius: 10, color: active ? 'var(--accent-primary)' : 'var(--text-secondary)', background: active ? 'var(--accent-soft)' : 'transparent', fontWeight: active ? 600 : 500, fontSize: 13.5 }}>
                <Icon name={n.icon} size={16} style={{ color: active ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} />
                {t(n.labelKey)}
              </button>
            )
          })}
        </div>
      </div>

      {/* main */}
      <div className="card-surface grow" style={{ overflowY: 'auto' }}>
        <div style={{ padding: '24px 40px 40px', maxWidth: 760 }}>
          {nav === 'appearance' && <><ThemeSettings theme={theme} onTheme={onTheme} /><AppearanceSettings /></>}
          {nav === 'security' && <SecuritySettings authEnabled={authEnabled} users={users} currentUser={currentUser} ownerUser={ownerUser} onEnableAuth={onEnableAuth} onDisableAuth={onDisableAuth} onLock={onLock} onRemoveUser={onRemoveUser} />}
          {nav === 'ai' && <AISettings />}
          {nav === 'connections' && <><ConnDefaults onImportSshConfig={onImportSshConfig} /><ConfigSyncBlock /></>}
          {nav === 'mcp' && <MCPSettings />}
          {nav === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}
