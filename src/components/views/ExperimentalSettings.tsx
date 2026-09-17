import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Btn, Toggle } from '../atoms'
import { opticalAvailable, opticalErrorKey, opticalLock, opticalStatus, opticalUnlock, type OpticalStatus } from '../../services/optical'
import { lockOptical, opticalRevision, setOpticalToken, useOpticalToken } from '../../state/optical'

export function ExperimentalSettings() {
  const { t } = useTranslation()
  const token = useOpticalToken()
  const [status, setStatus] = useState<OpticalStatus | null>(null)
  const [prompt, setPrompt] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const supported = opticalAvailable()
  useEffect(() => {
    let disposed = false
    if (supported) void opticalStatus().then(s => { if (!disposed) setStatus(s) })
      .catch(e => { if (!disposed) setError(opticalErrorKey(e)) })
    return () => { disposed = true; generation.current++ }
  }, [supported])
  function cancel() { generation.current++; setPrompt(false); setAcknowledged(false); setPassphrase(''); setConfirmation(''); setBusy(false); setError('') }
  async function unlock() {
    if (busy || !status?.visible || !acknowledged) return
    if (!status.configured && passphrase !== confirmation) { setError('optical.passphraseMismatch'); return }
    const attempt = ++generation.current
    const revision = opticalRevision()
    setBusy(true); setError('')
    const password = passphrase
    setPassphrase(''); setConfirmation('')
    try {
      const grant = await opticalUnlock(password, !status.configured)
      if (attempt !== generation.current || revision !== opticalRevision()) { await opticalLock(grant); return }
      setOpticalToken(grant); setStatus({ ...status, configured: true }); setPrompt(false)
    } catch (e) { if (attempt === generation.current) setError(opticalErrorKey(e)) }
    finally { if (attempt === generation.current) setBusy(false) }
  }
  if (status && !status.visible) return null
  return <section>
    <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>{t('optical.experimental')}</h2>
    <p style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 24 }}>{t('optical.settingsHint')}</p>
    <div className="row" style={{ justifyContent: 'space-between', gap: 16, padding: 16, border: '1px solid var(--border-hairline)', borderRadius: 14, background: 'var(--surface-card)' }}>
      <div className="col gap5"><strong style={{ fontSize: 14 }}>{t('optical.experimental')}</strong>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{token ? t('optical.enabledHint') : t('optical.disabledHint')}</span></div>
      <Toggle on={!!token} ariaLabel={t('optical.experimental')} accent onChange={enabled => {
        if (!enabled) { cancel(); void lockOptical(); return }
        if (!supported) { setError('optical.unavailable'); return }
        if (!status?.visible) { setError('optical.operationFailed'); return }
        if (!status.configured && !status.canConfigure) { setError('optical.adminRequired'); return }
        setError(''); setAcknowledged(false); setPrompt(true)
      }} />
    </div>
    <aside style={{ marginTop: 20, padding: 18, borderRadius: 12, background: 'var(--surface-sunken)', fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
      <strong>{t('optical.disclaimerTitle')}</strong><p style={{ margin: '6px 0 0' }}>{t('optical.disclaimer')}</p>
    </aside>
    {prompt && <form role="dialog" aria-modal="false" aria-label={t(status?.configured ? 'optical.unlockTitle' : 'optical.setupTitle')}
      onSubmit={e => { e.preventDefault(); void unlock() }} onKeyDown={e => { if (e.key === 'Escape') cancel() }}
      className="col gap12" style={{ marginTop: 16, padding: 20, border: '1px solid var(--accent-border)', borderRadius: 14, background: 'var(--surface-card)' }}>
      <strong>{t(status?.configured ? 'optical.unlockTitle' : 'optical.setupTitle')}</strong>
      {!status?.configured && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('optical.setupHint')}</span>}
      <label className="col gap5">{t('optical.passphrase')}<input autoFocus type="password" autoComplete={status?.configured ? 'current-password' : 'new-password'} maxLength={256} value={passphrase} disabled={busy}
        onChange={e => setPassphrase(e.target.value)} style={field} /></label>
      {!status?.configured && <label className="col gap5">{t('optical.confirmPassphrase')}<input type="password" autoComplete="new-password" maxLength={256} value={confirmation} disabled={busy}
        onChange={e => setConfirmation(e.target.value)} style={field} /></label>}
      <label className="row gap8" style={{ fontSize: 12, lineHeight: 1.6 }}><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />{t('optical.acknowledge')}</label>
      <div className="row gap8" style={{ justifyContent: 'flex-end' }}>
        <Btn variant="ghost" onClick={cancel}>{t('modals.cancel')}</Btn>
        <Btn type="submit" disabled={busy || !passphrase || !acknowledged}>{t(busy ? 'optical.unlocking' : 'optical.enable')}</Btn>
      </div>
    </form>}
    {error && <p role="alert" style={{ color: 'var(--danger-fg)', fontSize: 13 }}>{t(error)}</p>}
  </section>
}
const field = { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)' }
