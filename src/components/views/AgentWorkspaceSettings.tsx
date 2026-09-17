import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chooseLocalWorkspace } from '../../services/localFiles'
import { isTauri } from '../../services/transport'
import { saveAgentWorkspace, useAgentWorkspace } from '../../state/agentWorkspace'
import { Icon } from '../Icon'

export function AgentWorkspaceSettings() {
  const { t } = useTranslation()
  const path = useAgentWorkspace()
  const [draft, setDraft] = useState(path)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const desktop = isTauri()
  useEffect(() => { setDraft(path) }, [path])

  function showError(error: unknown) {
    const code = String(error instanceof Error ? error.message : error).split(':')[0]
    setMessage(t(`settings.${code}`, { defaultValue: t('settings.workspaceSaveFailed') }))
    setFailed(true)
  }
  async function choose() {
    setBusy(true); setMessage('')
    try {
      const selected = await chooseLocalWorkspace(path || undefined)
      if (selected) setDraft(selected)
    } catch (error) { showError(error) }
    finally { setBusy(false) }
  }
  async function save(value: string) {
    setBusy(true); setMessage('')
    try {
      await saveAgentWorkspace(value)
      setFailed(false); setMessage(t(value ? 'settings.workspaceSaved' : 'settings.workspaceCleared'))
    } catch (error) { showError(error) }
    finally { setBusy(false) }
  }
  return (
    <div className="col gap8" style={{ padding: '16px 0', borderBottom: '1px solid var(--border-hairline)' }}>
      <label htmlFor="agent-workspace-path" className="row gap8" style={{ fontWeight: 600 }}>
        <Icon name="folder" size={16} /> {t('settings.workspaceTitle')}
      </label>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {t(desktop ? 'settings.workspaceHint' : 'settings.workspaceDesktopOnly')}
      </span>
      <div className="row gap8" style={{ flexWrap: 'wrap' }}>
        <input id="agent-workspace-path" value={draft} disabled={!desktop || busy}
          placeholder={t('settings.workspacePlaceholder')}
          onChange={event => { setDraft(event.target.value); setMessage('') }}
          style={{ flex: '1 1 240px', minWidth: 0, height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)' }} />
        <button className="btn sm" disabled={!desktop || busy} onClick={() => void choose()}>{t('settings.workspaceChoose')}</button>
        <button className="btn btn-primary sm" disabled={!desktop || busy || !draft.trim()} onClick={() => void save(draft)}>{t('settings.workspaceSave')}</button>
        <button className="btn sm" disabled={!desktop || busy || !path} onClick={() => void save('')}>{t('settings.workspaceClear')}</button>
      </div>
      {desktop && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{t('settings.workspacePrivacy')}</span>}
      {message && <span role={failed ? 'alert' : 'status'} style={{ fontSize: 12, color: failed ? 'var(--signal-red)' : 'var(--signal-green)' }}>{message}</span>}
    </div>
  )
}
