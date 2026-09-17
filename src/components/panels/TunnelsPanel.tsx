/* Based on ref-ui/_extract/blob9.txt; evolved with live tunnel behavior. */
import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn, Toggle, Segmented, Btn } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Tunnel } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { getTunnels, getTunnelDefaults, tunnelOpen, tunnelClose, listen } from '../../services/ssh'
import { copyTextToClipboard } from '../../services/clipboard'
import type { ConnectionProfile } from '../../state/connections'

export interface JumpChainItem {
  name: string
  kind: 'local' | 'jump' | 'target'
  detail?: string
}

export interface TunnelsPanelProps {
  onClose: () => void
  sessionId?: string
  /** connId of the active tab — used to look up the jump chain. */
  activeConnId?: string
  /** All saved profiles — used to derive the real jump chain. */
  profiles?: ConnectionProfile[]
  /** Persist this forward as a reusable connection (C2). Absent → no save UI. */
  onSaveProfile?: (kind: 'L' | 'R' | 'D', bind: string, target: string, name: string) => void | Promise<void>
}

// ---- New-forward overlay form ----
interface NewForwardFormProps {
  onSubmit: (kind: 'L' | 'R' | 'D', bind: string, target: string) => void
  onCancel: () => void
  onSaveProfile?: (kind: 'L' | 'R' | 'D', bind: string, target: string, name: string) => void | Promise<void>
  busy: boolean
  defaultRemoteHost: string
  defaultLocalPort: string
  /** Backend failure to surface inside the form (e.g. bind in use, no SSH session). */
  error?: string | null
}

const MAX_PORT = 65_535
const COPY_FEEDBACK_DURATION_MS = 1_600
const FALLBACK_REMOTE_HOST = '127.0.0.1'
const FALLBACK_LOCAL_PORT = '0'

function isValidPort(value: string, allowZero: boolean): boolean {
  if (!/^\d+$/.test(value.trim())) return false
  const port = Number(value)
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= MAX_PORT
}

function formatTargetAddress(host: string, port: string): string {
  const trimmedHost = host.trim()
  if (trimmedHost.startsWith('[') && trimmedHost.endsWith(']')) return `${trimmedHost}:${port}`
  return trimmedHost.includes(':') ? `[${trimmedHost}]:${port}` : `${trimmedHost}:${port}`
}

function NewForwardForm({
  onSubmit,
  onCancel,
  onSaveProfile,
  busy,
  defaultRemoteHost,
  defaultLocalPort,
  error,
}: NewForwardFormProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<'L' | 'R' | 'D'>('L')
  const [bind, setBind] = useState(defaultLocalPort)
  const [remoteHost, setRemoteHost] = useState(defaultRemoteHost)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const bindEditedRef = useRef(false)
  const remoteHostEditedRef = useRef(false)

  const localMode = kind === 'L'
  const submittedTarget = localMode
    ? formatTargetAddress(remoteHost, target.trim())
    : target.trim()
  const canSubmit = localMode
    ? isValidPort(bind, true) && remoteHost.trim().length > 0 && isValidPort(target, false)
    : bind.trim().length > 0 && (kind === 'D' || target.trim().length > 0)

  useEffect(() => {
    if (localMode && !bindEditedRef.current) setBind(defaultLocalPort)
  }, [defaultLocalPort, localMode])

  useEffect(() => {
    if (localMode && !remoteHostEditedRef.current) setRemoteHost(defaultRemoteHost)
  }, [defaultRemoteHost, localMode])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmit || busy) return
    onSubmit(kind, bind.trim(), submittedTarget)
  }

  const handleKindChange = (value: string) => {
    if (busy) return
    const nextKind = value as 'L' | 'R' | 'D'
    setKind(nextKind)
    bindEditedRef.current = false
    remoteHostEditedRef.current = false
    setBind(nextKind === 'L' ? defaultLocalPort : '')
    setRemoteHost(defaultRemoteHost)
    setTarget('')
  }

  const inputStyle: React.CSSProperties = {
    height: 30, padding: '0 10px', borderRadius: 8, fontSize: 12,
    border: '1px solid var(--border-default)', background: 'var(--surface-sunken)',
    color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box',
  }
  const hintStyle: React.CSSProperties = { fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.4 }

  // Per-mode copy + example placeholders so first-time users know what each field expects.
  const bindPlaceholder = kind === 'D' ? 'localhost:1080' : kind === 'R' ? '0.0.0.0:9000' : '9999'
  const targetPlaceholder = kind === 'R' ? 'localhost:3000' : '8000'
  const bindLabel = localMode ? t('panels.fwdLocalPort') : t('panels.fwdBind')
  const targetLabel = localMode ? t('panels.fwdRemotePort') : t('panels.fwdTarget')

  return (
    <form onSubmit={handleSubmit}
      style={{
        position: 'absolute', top: 40, right: 12, zIndex: 20,
        background: 'var(--surface-card)', border: '1px solid var(--border-default)',
        borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: 'var(--shadow-overlay, 0 8px 24px rgba(0,0,0,.18))', width: 260,
        animation: 'growUp .14s ease',
      }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
        {t('panels.newForward')}
      </span>
      <Segmented
        size="sm"
        options={[
          { value: 'L', label: t('panels.fwdLocal'), disabled: busy },
          { value: 'R', label: t('panels.fwdRemote'), disabled: busy },
          { value: 'D', label: t('panels.fwdDynamic'), disabled: busy },
        ]}
        value={kind}
        onChange={handleKindChange}
      />
      {/* Mode explainer — switches with the selected tab so users know what they're building. */}
      <div style={{ ...hintStyle, padding: '7px 9px', borderRadius: 8, background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline, var(--border-default))' }}>
        {t(`panels.fwdHelp${kind}`)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{bindLabel}</span>
        <input
          style={inputStyle}
          type={localMode ? 'number' : 'text'}
          inputMode={localMode ? 'numeric' : undefined}
          min={localMode ? 0 : undefined}
          max={localMode ? MAX_PORT : undefined}
          aria-label={bindLabel}
          placeholder={bindPlaceholder}
          value={bind}
          onChange={e => {
            if (localMode) bindEditedRef.current = true
            setBind(e.target.value)
          }}
          disabled={busy}
          autoFocus
        />
        <span style={hintStyle}>{localMode ? t('panels.fwdLocalPortHint') : t(`panels.fwdBindHint${kind}`)}</span>
      </div>
      {localMode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.fwdRemoteHost')}</span>
          <input
            style={inputStyle}
            type="text"
            aria-label={t('panels.fwdRemoteHost')}
            placeholder="10.0.4.2"
            value={remoteHost}
            onChange={e => {
              remoteHostEditedRef.current = true
              setRemoteHost(e.target.value)
            }}
            disabled={busy}
          />
          <span style={hintStyle}>{t('panels.fwdRemoteHostHint')}</span>
        </div>
      )}
      {kind !== 'D' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{targetLabel}</span>
          <input
            style={inputStyle}
            type={localMode ? 'number' : 'text'}
            inputMode={localMode ? 'numeric' : undefined}
            min={localMode ? 1 : undefined}
            max={localMode ? MAX_PORT : undefined}
            aria-label={targetLabel}
            placeholder={targetPlaceholder}
            value={target}
            onChange={e => setTarget(e.target.value)}
            disabled={busy}
          />
          <span style={hintStyle}>{localMode ? t('panels.fwdRemotePortHint') : t(`panels.fwdTargetHint${kind}`)}</span>
        </div>
      )}
      {onSaveProfile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.fwdSaveName')}</span>
          <input style={inputStyle} placeholder={t('panels.fwdSaveNamePlaceholder')} value={name} onChange={e => setName(e.target.value)} disabled={busy} />
        </div>
      )}
      {error && (
        <span role="alert" style={{ fontSize: 11, color: 'var(--signal-red, #e5484d)', lineHeight: 1.4, wordBreak: 'break-word' }}>
          {error}
        </span>
      )}
      <div className="row gap6" style={{ justifyContent: 'flex-end' }}>
        <Btn type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('panels.cancel')}</Btn>
        {onSaveProfile && (
          <Btn type="button" variant="ghost" size="sm" onClick={() => { if (canSubmit && !busy && name.trim()) void onSaveProfile(kind, bind.trim(), submittedTarget, name.trim()) }} disabled={busy || !canSubmit || !name.trim()}>{t('panels.fwdSave')}</Btn>
        )}
        <Btn type="submit" variant="primary" size="sm" disabled={busy || !canSubmit}>{t('panels.fwdAdd')}</Btn>
      </div>
    </form>
  )
}

// ---- Main panel ----

export function TunnelsPanel({ onClose, sessionId, activeConnId, profiles, onSaveProfile }: TunnelsPanelProps) {
  const { t } = useTranslation()
  const D = useData()
  const typeLabel: Record<string, string> = { L: 'Local', R: 'Remote', D: 'Dynamic' }

  // Derive the real jump chain from the active profile (or fall back to mock D.jumpChain).
  const activeProfile = profiles && activeConnId
    ? profiles.find(p => p.id === activeConnId)
    : undefined

  const jumpChain: JumpChainItem[] = activeProfile
    ? [
        { name: '本地', kind: 'local' as const },
        ...(activeProfile.jump
          ? [{
              name: activeProfile.jump.host,
              kind: 'jump' as const,
              detail: `${activeProfile.jump.user}@${activeProfile.jump.host}:${activeProfile.jump.port}`,
            }]
          : []),
        {
          name: activeProfile.name,
          kind: 'target' as const,
          detail: `${activeProfile.user}@${activeProfile.host}:${activeProfile.port}`,
        },
      ]
    : D.jumpChain

  const [tunnels, setTunnels] = useState<Tunnel[]>([])
  const [showForm, setShowForm] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copiedTunnelId, setCopiedTunnelId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [forwardDefaults, setForwardDefaults] = useState({
    remoteHost: FALLBACK_REMOTE_HOST,
    localPort: FALLBACK_LOCAL_PORT,
  })
  const overlayRef = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const operationRef = useRef<symbol | null>(null)
  const copyRequestRef = useRef<symbol | null>(null)
  const sessionIdRef = useRef(sessionId)
  const contextKey = `${sessionId ?? ''}\u0000${activeConnId ?? ''}`
  const contextKeyRef = useRef(contextKey)
  sessionIdRef.current = sessionId
  contextKeyRef.current = contextKey

  const load = (requestedSessionId = sessionId) => {
    getTunnels(requestedSessionId).then(list => {
      if (sessionIdRef.current === requestedSessionId) setTunnels(list)
    }).catch(() => {
      // keep current state on error
    })
  }

  // Load on mount and sessionId change
  useEffect(() => {
    // Never leave the previous host's rows interactive while the next host is loading.
    setTunnels([])
    if (sessionId) {
      load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Preload form defaults for this SSH session. The remote host is discovered from the server's
  // default route and the local port is selected by the local OS; stale responses are discarded.
  useEffect(() => {
    let disposed = false
    setForwardDefaults({ remoteHost: FALLBACK_REMOTE_HOST, localPort: FALLBACK_LOCAL_PORT })
    if (!sessionId) return () => { disposed = true }

    void getTunnelDefaults(sessionId).then(defaults => {
      if (disposed || sessionIdRef.current !== sessionId) return
      const localPort = Number.isInteger(defaults.localPort)
        && defaults.localPort > 0
        && defaults.localPort <= MAX_PORT
        ? String(defaults.localPort)
        : FALLBACK_LOCAL_PORT
      setForwardDefaults({
        remoteHost: defaults.remoteHost.trim() || FALLBACK_REMOTE_HOST,
        localPort,
      })
    }).catch(() => {
      // 远端缺少 ip/hostname 命令或默认值探测失败时，保留回环地址 + 端口 0 的安全回退。
    })

    return () => { disposed = true }
  }, [sessionId])

  // Subscribe to per-tunnel live byte-count events
  useEffect(() => {
    if (!sessionId) return
    const unlisteners: Array<() => void> = []
    let disposed = false
    tunnels.forEach(t2 => {
      listen<{ bytesUp: number; bytesDown: number }>(`tunnel://${t2.id}`, payload => {
        if (sessionIdRef.current !== sessionId) return
        setTunnels(prev =>
          prev.map(row =>
            row.id === t2.id
              ? { ...row, bytes: formatBytesLocal(payload.bytesUp + payload.bytesDown) }
              : row,
          ),
        )
      }).then(unlisten => {
        if (disposed) unlisten()
        else unlisteners.push(unlisten)
      }).catch(() => {
        // A failed event subscription must not create an unhandled rejection.
      })
    })
    return () => {
      disposed = true
      unlisteners.forEach(fn => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tunnels.map(t2 => t2.id).join(',')])

  // Close overlay when clicking outside
  useEffect(() => {
    if (!showForm) return
    const handler = (e: MouseEvent) => {
      if (operationRef.current) return
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setShowForm(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showForm])

  // A closed form starts clean next time it opens — don't carry a stale error across opens.
  useEffect(() => { if (!showForm) setFormError(null) }, [showForm])

  // A host-tab switch invalidates transient form/feedback state so values from one SSH session
  // can never be submitted against another session after React reuses this panel instance.
  useEffect(() => {
    operationRef.current = null
    copyRequestRef.current = null
    setSubmitting(false)
    setShowForm(false)
    setFormError(null)
    setSaveNotice(null)
    setCopyError(null)
    setCopiedTunnelId(null)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = null
  }, [sessionId, activeConnId])

  useEffect(() => () => {
    operationRef.current = null
    copyRequestRef.current = null
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  const handleToggle = (t2: Tunnel, nowOn: boolean) => {
    if (!sessionId) return
    if (!nowOn && t2.status === 'up') {
      // OFF → close tunnel
      tunnelClose(t2.id).then(() => load()).catch(() => load())
    }
    // ON → reopening a closed tunnel needs original spec; not wired (deferred)
  }

  const handleCreate = async (kind: 'L' | 'R' | 'D', bind: string, target: string) => {
    if (operationRef.current) return
    // No active SSH session → no transport to build a tunnel over. Tell the user instead of
    // doing nothing (the original silent `return` looked like a dead button).
    if (!sessionId) { setFormError(t('panels.noSessionHint')); return }
    const token = Symbol('create-tunnel')
    const submittedContext = contextKey
    const submittedSessionId = sessionId
    operationRef.current = token
    setSubmitting(true)
    setFormError(null)
    try {
      await tunnelOpen(submittedSessionId, { kind, bind, target: kind === 'D' ? null : target || null })
      load(submittedSessionId)
      if (operationRef.current === token && contextKeyRef.current === submittedContext) setShowForm(false)
    } catch (e: unknown) {
      load(submittedSessionId)
      // Surface the backend error (bind in use, target unreachable, …) rather than swallowing it.
      if (operationRef.current === token && contextKeyRef.current === submittedContext) {
        setFormError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (operationRef.current === token) {
        operationRef.current = null
        if (contextKeyRef.current === submittedContext) setSubmitting(false)
      }
    }
  }

  const handleSaveProfile = async (kind: 'L' | 'R' | 'D', bind: string, target: string, name: string) => {
    if (!onSaveProfile || operationRef.current) return
    const token = Symbol('save-tunnel-profile')
    const submittedContext = contextKey
    operationRef.current = token
    setSubmitting(true)
    setFormError(null)
    try {
      await onSaveProfile(kind, bind, target, name)
      if (operationRef.current === token && contextKeyRef.current === submittedContext) {
        setShowForm(false)
        setSaveNotice(t('panels.fwdSaved', { name }))
      }
    } catch (e: unknown) {
      if (operationRef.current === token && contextKeyRef.current === submittedContext) {
        setFormError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (operationRef.current === token) {
        operationRef.current = null
        if (contextKeyRef.current === submittedContext) setSubmitting(false)
      }
    }
  }

  const handleCopyLocal = async (tunnel: Tunnel) => {
    const token = Symbol('copy-tunnel-address')
    const copiedContext = contextKey
    copyRequestRef.current = token
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = null
    setCopiedTunnelId(null)
    setCopyError(null)
    let copied = false
    try {
      copied = await copyTextToClipboard(tunnel.local)
    } catch {
      copied = false
    }
    if (copyRequestRef.current !== token || contextKeyRef.current !== copiedContext) return
    if (!copied) {
      copyRequestRef.current = null
      setCopyError(t('panels.copyFailed'))
      return
    }
    copyRequestRef.current = null
    setCopyError(null)
    setCopiedTunnelId(tunnel.id)
    copyTimerRef.current = setTimeout(() => {
      setCopiedTunnelId(null)
      copyTimerRef.current = null
    }, COPY_FEEDBACK_DURATION_MS)
  }

  return (
    <PanelShell
      icon="link"
      title={t('panels.tunnelsTitle')}
      sub={t('panels.tunnelsSub')}
      onClose={onClose}
      actions={
        <div ref={overlayRef} style={{ position: 'relative' }}>
          <IconBtn
            name="plus"
            size={15}
            variant="bare"
            title={t('panels.newForward')}
            onClick={() => {
              if (operationRef.current) return
              setSaveNotice(null)
              setShowForm(v => !v)
            }}
            active={showForm}
          />
          {showForm && (
            <NewForwardForm
              error={formError}
              busy={submitting}
              defaultRemoteHost={forwardDefaults.remoteHost}
              defaultLocalPort={forwardDefaults.localPort}
              onSubmit={handleCreate}
              onCancel={() => setShowForm(false)}
              onSaveProfile={onSaveProfile ? handleSaveProfile : undefined}
            />
          )}
        </div>
      }
    >
      {!sessionId ? (
        <PanelEmpty icon="link" text={t('panels.noSessionHint')} />
      ) : (
        <>
          {/* jump chain — only shown when there is a jump hop or always for session context */}
          {jumpChain.length > 0 && (
            <div className="col" style={{ padding: '12px 12px', borderBottom: '1px solid var(--border-hairline)', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>ProxyJump</span>
              <div className="row" style={{ gap: 0, flexWrap: 'wrap' }}>
                {jumpChain.map((h, i) => (
                  <React.Fragment key={i}>
                    <div className="row gap6" style={{ padding: '5px 9px', borderRadius: 8, background: h.kind === 'target' ? 'var(--accent-soft)' : 'var(--surface-sunken)' }}
                      title={h.detail}>
                      <Icon name={h.kind === 'local' ? 'monitor' : h.kind === 'jump' ? 'shield' : 'server'} size={13} style={{ color: h.kind === 'target' ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} />
                      <span className="mono" style={{ fontSize: 11.5, color: h.kind === 'target' ? 'var(--accent-primary)' : 'var(--text-secondary)', fontWeight: h.kind === 'target' ? 600 : 400 }}>{h.name}</span>
                    </div>
                    {i < jumpChain.length - 1 && <Icon name="arrow-right" size={13} style={{ color: 'var(--text-disabled)', margin: '0 4px' }} />}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          {saveNotice && (
            <div role="status" style={{ margin: '10px 10px 0', padding: '8px 10px', borderRadius: 8, color: 'var(--signal-green)', background: 'var(--signal-green-soft, var(--surface-sunken))', fontSize: 11 }}>
              {saveNotice}
            </div>
          )}
          {copyError && (
            <div role="alert" style={{ margin: '10px 10px 0', padding: '8px 10px', borderRadius: 8, color: 'var(--danger-fg)', background: 'var(--danger-soft)', fontSize: 11 }}>
              {copyError}
            </div>
          )}
          <div className="grow" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Empty state: explain the feature + the three modes so first-time users aren't stuck. */}
            {tunnels.length === 0 && (
              <div className="col" style={{ gap: 10, padding: '6px 2px' }}>
                <div className="col" style={{ gap: 3 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('panels.fwdEmptyTitle')}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('panels.fwdEmptyHint')}</span>
                </div>
                <div className="col" style={{ gap: 6 }}>
                  {(['L', 'R', 'D'] as const).map(k => (
                    <div key={k} className="col" style={{ gap: 2, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-sunken)', border: '1px solid var(--border-hairline)' }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent-primary)' }}>
                        {t(k === 'L' ? 'panels.fwdLocal' : k === 'R' ? 'panels.fwdRemote' : 'panels.fwdDynamic')}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>{t(`panels.fwdHelp${k}`)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {tunnels.map(t2 => (
              <div key={t2.id} className="col" style={{ border: '1px solid var(--border-hairline)', borderRadius: 12, padding: 11, gap: 8, background: 'var(--surface-card)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="row gap8">
                    <div className="icon-badge" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--surface-sunken)', color: 'var(--text-tertiary)' }}><span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{t2.type}</span></div>
                    <div className="col" style={{ lineHeight: 1.25 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t2.label}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{typeLabel[t2.type]} · via {t2.via}</span>
                    </div>
                  </div>
                  <Toggle on={t2.status === 'up'} size="sm" onChange={nowOn => handleToggle(t2, nowOn)} />
                </div>
                <div className="row mono gap6" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  <button
                    type="button"
                    className="tunnel-local-copy"
                    onClick={() => handleCopyLocal(t2)}
                    title={copiedTunnelId === t2.id ? t('panels.copied') : t('panels.copy')}
                    aria-label={`${copiedTunnelId === t2.id ? t('panels.copied') : t('panels.copy')} ${t2.local}`}
                  >
                    <span>{t2.local}</span>
                    <Icon name={copiedTunnelId === t2.id ? 'check' : 'copy'} size={10} />
                  </button>
                  <Icon name="arrow-right" size={11} />
                  <span>{t2.remote}</span>
                  <span className="grow" />
                  <span style={{ color: 'var(--text-faint)' }}>{t2.bytes}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </PanelShell>
  )
}

// local copy to avoid circular imports in this module
function formatBytesLocal(n: number): string {
  if (n === 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
