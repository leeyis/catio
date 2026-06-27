/* Remote file editor pane — reads a remote file into the generic CodeEditor,
 * saves back over SFTP with mtime conflict detection. Opened as a top-level
 * 'remote-file' tab from the SFTP panel. Handles loading / error / binary /
 * truncated (read-only preview) / conflict states. */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeEditor } from '../editor/CodeEditor'
import { detectLang } from '../editor/langByExt'
import { sftpReadFile, sftpWriteFile } from '../../services/ssh'
import { startDownload } from '../../state/transfers'
import { Icon } from '../Icon'

export interface RemoteFileEditorProps {
  sessionId?: string
  path: string
  /** Reports unsaved-changes state up to the tab bar (dirty dot). */
  onDirtyChange?: (dirty: boolean) => void
}

type Phase = 'loading' | 'error' | 'binary' | 'ready'

export function RemoteFileEditor({ sessionId, path, onDirtyChange }: RemoteFileEditorProps) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const baseModifiedRef = useRef<number | null>(null)
  const modeRef = useRef<number | null>(null)

  const lang = useMemo(() => detectLang(path), [path])
  const fileName = useMemo(() => path.split(/[/\\]/).pop() || path, [path])
  const dirty = phase === 'ready' && !truncated && value !== savedValue

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const doLoad = useCallback(async () => {
    if (!sessionId) { setPhase('error'); setErrMsg(t('remoteFile.noSession')); return }
    setPhase('loading')
    setConflict(false)
    try {
      const r = await sftpReadFile(sessionId, path)
      baseModifiedRef.current = r.modified
      modeRef.current = r.mode
      setTruncated(r.truncated)
      if (r.isBinary) { setPhase('binary'); return }
      setValue(r.content)
      setSavedValue(r.content)
      setPhase('ready')
    } catch (e) {
      setPhase('error')
      setErrMsg(String((e as { message?: string } | null)?.message ?? e))
    }
  }, [sessionId, path, t])

  useEffect(() => { void doLoad() }, [doLoad])

  const save = useCallback(async (force?: boolean) => {
    if (!sessionId || saving || truncated) return
    if (value === savedValue && !force) return
    setSaving(true)
    try {
      const newMtime = await sftpWriteFile(
        sessionId, path, value,
        force ? null : baseModifiedRef.current,
        modeRef.current,
      )
      baseModifiedRef.current = newMtime
      setSavedValue(value)
      setConflict(false)
    } catch (e) {
      const kind = (e as { kind?: string } | null)?.kind
      if (kind === 'Conflict') setConflict(true)
      else { setPhase('error'); setErrMsg(String((e as { message?: string } | null)?.message ?? e)) }
    } finally {
      setSaving(false)
    }
  }, [sessionId, path, value, savedValue, saving, truncated])

  // Stable Ctrl/Cmd+S hook for the editor (avoids remounting on every keystroke).
  const saveRef = useRef(save)
  saveRef.current = save
  const onSave = useCallback(() => { void saveRef.current() }, [])

  // Binary / oversize fallback — download via the same transfer flow as the SFTP panel.
  const downloadSelf = useCallback(() => {
    if (!sessionId) return
    void import('@tauri-apps/plugin-dialog').then(({ save: saveDialog }) => {
      void saveDialog({ defaultPath: fileName }).then(dest => {
        if (!dest) return
        const dir = path.replace(/\/[^/]*$/, '') || '/'
        startDownload(sessionId, path, dest, dir, fileName).catch(() => {})
      })
    })
  }, [sessionId, path, fileName])

  if (phase === 'loading') {
    return <Centered><span style={{ color: 'var(--text-tertiary)' }}>{t('remoteFile.loading')}</span></Centered>
  }
  if (phase === 'error') {
    return (
      <Centered>
        <Icon name="alert-triangle" size={22} style={{ color: 'var(--signal-amber)' }} />
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, maxWidth: 420, textAlign: 'center' }}>{errMsg}</div>
        <button className="btn" onClick={() => void doLoad()} style={pillStyle}>
          <Icon name="refresh-cw" size={13} /> {t('remoteFile.retry')}
        </button>
      </Centered>
    )
  }
  if (phase === 'binary') {
    return (
      <Centered>
        <Icon name="alert-triangle" size={22} style={{ color: 'var(--text-tertiary)' }} />
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('remoteFile.binary')}</div>
        {sessionId && (
          <button className="btn" onClick={downloadSelf} style={pillStyle}>
            <Icon name="arrow-down" size={13} /> {t('remoteFile.download')}
          </button>
        )}
      </Centered>
    )
  }

  return (
    <div className="col" style={{ height: '100%', width: '100%', position: 'relative', minHeight: 0 }}>
      {/* header: file name · language · dirty · save */}
      <div className="row" style={{ flex: 'none', alignItems: 'center', gap: 10, height: 36, padding: '0 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-card)' }}>
        <Icon name="file-code" size={14} style={{ color: 'var(--text-tertiary)' }} />
        <span className="ell" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', maxWidth: 320 }}>{fileName}</span>
        {lang && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{lang.label}</span>}
        {dirty && <span className="dot" style={{ background: 'var(--signal-amber)' }} title={t('remoteFile.unsaved')} />}
        <div className="grow" />
        {!truncated && (
          <button className="btn" onClick={onSave} disabled={!dirty || saving} style={{ ...pillStyle, opacity: !dirty || saving ? 0.5 : 1, cursor: !dirty || saving ? 'default' : 'pointer' }}>
            <Icon name="circle-check" size={13} /> {saving ? t('remoteFile.saving') : t('remoteFile.save')}
          </button>
        )}
      </div>

      {truncated && (
        <div className="row" style={{ flex: 'none', gap: 8, padding: '6px 12px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--border-hairline)', fontSize: 12, color: 'var(--text-secondary)' }}>
          <Icon name="alert-triangle" size={13} style={{ color: 'var(--signal-amber)' }} />
          {t('remoteFile.truncated')}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <CodeEditor value={value} onChange={setValue} language={lang?.ext ?? null} readOnly={truncated} onSave={onSave} />
      </div>

      {/* conflict banner — remote changed since open */}
      {conflict && (
        <div className="row" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, gap: 10, alignItems: 'center', padding: '10px 14px', background: 'var(--surface-elevated)', border: '1px solid var(--signal-amber)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', zIndex: 20 }}>
          <Icon name="alert-triangle" size={16} style={{ color: 'var(--signal-amber)' }} />
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-primary)' }}>{t('remoteFile.conflict')}</span>
          <button className="btn" onClick={() => void doLoad()} style={pillStyle}>{t('remoteFile.reload')}</button>
          <button className="btn" onClick={() => void save(true)} style={{ ...pillStyle, color: 'var(--signal-amber)' }}>{t('remoteFile.overwrite')}</button>
          <button className="btn" onClick={() => setConflict(false)} style={pillStyle}>{t('remoteFile.cancel')}</button>
        </div>
      )}
    </div>
  )
}

const pillStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, height: 27, padding: '0 12px',
  borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)',
  color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="col" style={{ height: '100%', width: '100%', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--surface-subtle)' }}>
      {children}
    </div>
  )
}
