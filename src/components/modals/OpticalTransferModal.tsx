import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Btn, IconBtn } from '../atoms'
import type { SftpItem } from '../../services/types'
import { opticalBytes, opticalCancel, opticalErrorKey, opticalRead } from '../../services/optical'
import { useOpticalToken } from '../../state/optical'

export function OpticalTransferModal({ item, sessionId, onClose }: { item: SftpItem; sessionId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const token = useOpticalToken()
  const [started, setStarted] = useState(false)
  const [phase, setPhase] = useState<'preparing' | 'playing' | 'paused' | 'error'>('preparing')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const iframe = useRef<HTMLIFrameElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const requestId = useRef('')

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current() }
      if (e.key === 'Tab') {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')
        if (!nodes?.length) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); previous?.focus() }
  }, [])
  useEffect(() => { if (!token) closeRef.current() }, [token])

  useEffect(() => {
    if (!started || !token) return
    let disposed = false
    let failed = false
    let ready = false
    let payload: { name: string; bytes: Uint8Array } | null = null
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    requestId.current = id
    const fail = (e: unknown) => {
      if (disposed || failed) return
      failed = true; payload?.bytes.fill(0); payload = null
      setError(opticalErrorKey(e)); setPhase('error')
      void opticalCancel(token, id).catch(() => {})
    }
    const send = () => {
      if (!disposed && !failed && ready && payload && iframe.current?.contentWindow) {
        const data = payload; payload = null
        iframe.current.contentWindow.postMessage({ channel: 'catio-cimbar', type: 'load', requestId: id, name: data.name, buffer: data.bytes.buffer }, '*', [data.bytes.buffer])
      }
    }
    const timeout = setTimeout(() => fail(new Error('optical.encoderTimeout')), 100_000)
    const message = (e: MessageEvent) => {
      if (disposed || failed || e.source !== iframe.current?.contentWindow || e.data?.channel !== 'catio-cimbar') return
      if (e.data.type === 'ready') { ready = true; send(); return }
      if (e.data.requestId !== id && e.data.type !== 'error') return
      if (e.data.type === 'loaded' || e.data.type === 'playing') { clearTimeout(timeout); setPhase('playing') }
      if (e.data.type === 'paused') setPhase('paused')
      if (e.data.type === 'error') { clearTimeout(timeout); fail(new Error('optical.encoderFailed')) }
    }
    window.addEventListener('message', message)
    void opticalRead(token, id, sessionId, item.path).then(file => {
      if (disposed || failed) return
      payload = { name: file.name, bytes: opticalBytes(file.data) }
      send()
    }).catch(fail)
    return () => {
      disposed = true; payload?.bytes.fill(0); payload = null
      clearTimeout(timeout); window.removeEventListener('message', message)
      void opticalCancel(token, id).catch(() => {})
    }
  }, [started, token, sessionId, item.path])

  function pauseResume() {
    iframe.current?.contentWindow?.postMessage({ channel: 'catio-cimbar', type: phase === 'paused' ? 'play' : 'pause', requestId: requestId.current }, '*')
  }
  async function fullscreen() {
    if (document.fullscreenElement) { await document.exitFullscreen(); setExpanded(false) }
    else if (dialog.current?.requestFullscreen) { try { await dialog.current.requestFullscreen() } catch { setExpanded(v => !v) } }
    else setExpanded(v => !v)
  }
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 180, background: 'color-mix(in srgb, var(--cta-bg) 48%, transparent)', display: 'grid', placeItems: 'center' }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t('optical.title')} tabIndex={-1} className="col"
      style={{ width: expanded ? '100vw' : 'min(1000px, 96vw)', height: expanded ? '100vh' : '94vh', background: 'var(--surface-card)', color: 'var(--text-primary)', border: '1px solid var(--border-hairline)', borderRadius: expanded ? 0 : 16, overflow: 'hidden', boxShadow: 'var(--shadow-window)' }}>
      <div className="row gap12" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-hairline)' }}>
        <strong>{t('optical.title')}</strong><span className="ell grow" title={item.name} style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{item.name}</span>
        <IconBtn name="x" title={t('optical.close')} onClick={onClose} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'grid', placeItems: 'center' }}>
        {started && phase !== 'error' && token && <iframe ref={iframe} title={t('optical.canvas')} src="/vendor/cimbar/encoder.html" sandbox="allow-scripts" tabIndex={-1}
          style={{ width: '100%', height: '100%', border: 0, pointerEvents: 'none', visibility: phase === 'preparing' ? 'hidden' : 'visible' }} />}
        {!started && <div className="col gap12" style={{ maxWidth: 520, padding: 28, lineHeight: 1.7 }}>
          <strong>{t('optical.readyTitle')}</strong><span>{t('optical.instructions')}</span>
          <span style={{ color: 'var(--signal-amber)', fontSize: 13 }}>{t('optical.flashWarning')}</span>
          <Btn onClick={() => setStarted(true)}>{t('optical.start')}</Btn>
        </div>}
        {started && phase === 'preparing' && <span role="status" style={{ position: 'absolute' }}>{t('optical.preparing')}</span>}
        {phase === 'error' && <p role="alert" style={{ padding: 24, color: 'var(--danger-fg)' }}>{t(error)}</p>}
      </div>
      <div className="row gap12" style={{ padding: '12px 18px', borderTop: '1px solid var(--border-hairline)', flexWrap: 'wrap' }}>
        <span className="grow" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t(phase === 'paused' ? 'optical.pausedHint' : 'optical.receiverHint')}</span>
        {started && phase !== 'error' && <Btn variant="secondary" disabled={phase === 'preparing'} onClick={pauseResume}>{t(phase === 'paused' ? 'optical.resume' : 'optical.pause')}</Btn>}
        <Btn variant="secondary" onClick={() => void fullscreen()}>{t('optical.fullscreen')}</Btn>
        <Btn variant="ghost" onClick={onClose}>{t('optical.close')}</Btn>
      </div>
    </div>
  </div>, document.body)
}
