/* ported from ref-ui/_extract/blob12.txt — verbatim per plan T1-T7 */
import React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Toggle, Segmented } from '../atoms'
import { useLang } from '../../state/LanguageContext'

// ---- Prop types ----

export interface User {
  username: string
  hint?: string
}

export interface SettingsViewProps {
  theme: string
  onTheme: (id: string) => void
  onClose: () => void
  authEnabled?: boolean
  users?: User[]
  currentUser?: string
  ownerUser?: string
  onEnableAuth?: () => void
  onDisableAuth?: () => void
  onLock?: () => void
  onRemoveUser?: (username: string) => void
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
  { id: 'theme', icon: 'palette', labelKey: 'settings.navTheme' },
  { id: 'appearance', icon: 'type', labelKey: 'settings.navAppearance' },
  { id: 'security', icon: 'shield', labelKey: 'settings.navSecurity' },
  { id: 'ai', icon: 'sparkles', labelKey: 'settings.navAi' },
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
    <Block title={t('settings.themeTitle')} hint={t('settings.themeHint')}>
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
      <SettingRow icon="monitor" title={t('settings.followSystem')} desc={t('settings.followSystemDesc')} control={<Toggle on={false} />} />
      <SettingRow icon="palette" title={t('settings.accentSubtle')} desc={t('settings.accentSubtleDesc')} control={<Toggle on={true} />} />
    </Block>
  )
}

function AppearanceSettings() {
  const { t } = useTranslation()
  const { lang, setLang } = useLang()
  return (
    <Block title={t('settings.appearanceTitle')} hint={t('settings.appearanceHint')}>
      <SettingRow icon="type" title={t('settings.uiFont')} desc={t('settings.uiFontDesc')} control={<span className="chip">Inter</span>} />
      <SettingRow icon="code" title={t('settings.monoFont')} desc={t('settings.monoFontDesc')} control={<span className="chip mono">Geist Mono</span>} />
      <SettingRow icon="terminal" title={t('settings.termFontSize')} desc={t('settings.termFontSizeDesc')} control={<span className="chip mono">12.5 px</span>} />
      <SettingRow icon="sliders" title={t('settings.density')} desc={t('settings.densityDesc')} control={<Toggle on={false} />} />
      <SettingRow icon="zap" title={t('settings.webgl')} desc={t('settings.webglDesc')} control={<Toggle on={true} />} />
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
  return (
    <Block title={t('settings.securityTitle')} hint={t('settings.securityHint')}>
      {/* multi-user identity gate */}
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

      <SettingRow icon="lock" title={t('settings.vaultEncryption')} desc={t('settings.vaultEncryptionDesc')} control={<span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 13%, transparent)', color: 'var(--signal-green)' }}><Icon name="check" size={11} /> {t('settings.vaultEncryptionEnabled')}</span>} />
      <SettingRow icon="key" title={t('settings.keystoreUnlock')} desc={t('settings.keystoreUnlockDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="shield" title={t('settings.aiSafetyCheck')} desc={t('settings.aiSafetyCheckDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="globe" title={t('settings.vaultSync')} desc={t('settings.vaultSyncDesc')} control={<Toggle on={false} />} />
      <SettingRow icon="trash-2" title={t('settings.clearCredentials')} desc={t('settings.clearCredentialsDesc')} danger control={<Btn variant="danger" size="sm">{t('settings.clearBtn')}</Btn>} />
    </Block>
  )
}

function AISettings() {
  const { t } = useTranslation()
  return (
    <Block title={t('settings.aiSettingsTitle')} hint={t('settings.aiSettingsHint')}>
      <SettingRow icon="box" title={t('settings.aiModel')} desc={t('settings.aiModelDesc')} control={<span className="chip">claude-sonnet</span>} />
      <SettingRow icon="terminal" title={t('settings.aiTermBuffer')} desc={t('settings.aiTermBufferDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="database" title={t('settings.aiDbSchema')} desc={t('settings.aiDbSchemaDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="radar" title={t('settings.aiMultiHost')} desc={t('settings.aiMultiHostDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="shield" title={t('settings.aiReadonly')} desc={t('settings.aiReadonlyDesc')} control={<Toggle on={false} />} />
    </Block>
  )
}

function ConnDefaults() {
  const { t } = useTranslation()
  return (
    <Block title={t('settings.connDefaultsTitle')} hint={t('settings.connDefaultsHint')}>
      <SettingRow icon="git-branch" title={t('settings.importSshConfig')} desc={t('settings.importSshConfigDesc')} control={<Btn variant="secondary" size="sm" icon="download">{t('settings.importBtn')}</Btn>} />
      <SettingRow icon="link" title={t('settings.savePortForwarding')} desc={t('settings.savePortForwardingDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="refresh-cw" title={t('settings.sessionRestore')} desc={t('settings.sessionRestoreDesc')} control={<Toggle on={true} />} />
      <SettingRow icon="circle-dot" title={t('settings.connColorLabel')} desc={t('settings.connColorDesc')} control={<Toggle on={true} />} />
    </Block>
  )
}

function MCPSettings() {
  const { t } = useTranslation()
  return (
    <Block title={t('settings.mcpTitle')} hint={t('settings.mcpHint')}>
      <div style={{ padding: 16, border: '1px solid var(--border-hairline)', borderRadius: 14, background: 'var(--surface-subtle)', marginBottom: 12 }}>
        <div className="row gap8" style={{ marginBottom: 10 }}><Icon name="command" size={15} style={{ color: 'var(--accent-primary)' }} /><span style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.mcpServerLabel')}</span><span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 13%, transparent)', color: 'var(--signal-green)', marginLeft: 'auto' }}><span className="dot" style={{ background: 'var(--signal-green)' }} /> {t('settings.mcpRunning')}</span></div>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('settings.mcpDesc')}</p>
        <pre className="mono" style={{ margin: 0, padding: '10px 12px', background: 'var(--term-bg)', color: 'var(--term-fg)', borderRadius: 10, fontSize: 11.5, overflow: 'auto' }}>{`$ npm install -g @catio-app/cli\n$ catio connections list --json\n$ catio query prod-orders "select 1" --json`}</pre>
      </div>
      <SettingRow icon="plug" title={t('settings.mcpOpenWindow')} desc={t('settings.mcpOpenWindowDesc')} control={<Toggle on={true} />} />
    </Block>
  )
}

function AboutSettings() {
  const { t } = useTranslation()
  return (
    <Block title={t('settings.aboutTitle')}>
      <div className="row gap16" style={{ padding: 20, border: '1px solid var(--border-hairline)', borderRadius: 16, background: 'var(--surface-subtle)' }}>
        <div className="logo-mark" style={{ width: 56, height: 56, borderRadius: 18 }}><span className="mono" style={{ fontSize: 26, fontWeight: 700 }}>&gt;_</span></div>
        <div className="col" style={{ gap: 4 }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px' }}>Catio</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, maxWidth: 420 }}><Trans i18nKey="settings.aboutDesc" components={{ b: <b /> }} /></span>
          <div className="row gap6" style={{ marginTop: 6 }}><span className="chip mono">Tauri</span><span className="chip mono">Rust</span><span className="chip mono">40+ databases</span><span className="chip mono">15 MB</span></div>
        </div>
      </div>
    </Block>
  )
}

export function SettingsView({ theme, onTheme, onClose, authEnabled, users, currentUser, ownerUser, onEnableAuth, onDisableAuth, onLock, onRemoveUser }: SettingsViewProps) {
  const { t } = useTranslation()
  const [nav, setNav] = React.useState('theme')
  return (
    <div className="body fade-in" style={{ flex: 1 }}>
      {/* left nav */}
      <div className="card-surface col" style={{ width: 220, flex: 'none', padding: '16px 10px' }}>
        <div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}>{t('settings.title')}</span>
          <IconBtn name="x" size={15} variant="bare" onClick={onClose} />
        </div>
        <div className="col" style={{ gap: 2 }}>
          {SETTINGS_NAV.map(n => {
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
        <div className="grow" />
        <div className="row gap8" style={{ padding: '10px 10px', background: 'var(--surface-sunken)', borderRadius: 12 }}>
          <div className="logo-mark" style={{ width: 30, height: 30 }}><span className="mono" style={{ fontSize: 14, fontWeight: 700 }}>&gt;_</span></div>
          <div className="col" style={{ lineHeight: 1.25 }}><span style={{ fontSize: 12, fontWeight: 600 }}>Catio</span><span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>v1.0 · Reach × DBX</span></div>
        </div>
      </div>

      {/* main */}
      <div className="card-surface grow" style={{ overflowY: 'auto' }}>
        <div style={{ padding: '24px 40px 40px', maxWidth: 760 }}>
          {nav === 'theme' && <ThemeSettings theme={theme} onTheme={onTheme} />}
          {nav === 'appearance' && <AppearanceSettings />}
          {nav === 'security' && <SecuritySettings authEnabled={authEnabled} users={users} currentUser={currentUser} ownerUser={ownerUser} onEnableAuth={onEnableAuth} onDisableAuth={onDisableAuth} onLock={onLock} onRemoveUser={onRemoveUser} />}
          {nav === 'ai' && <AISettings />}
          {nav === 'connections' && <ConnDefaults />}
          {nav === 'mcp' && <MCPSettings />}
          {nav === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}
