import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn } from '../atoms'
import {
  sqlFilePreview, runSqlFile, cancelSqlFile, onSqlFileProgress, dbErrMsg,
  type SqlFilePreview,
} from '../../services/db'
import {
  initialRunState, isTerminalStatus, reduceProgress, progressPercent,
  type SqlFileRunState,
} from './sqlFileRun'

export interface SqlFileDialogProps {
  connId: string
  /** 连接名,用于「正在 X 上执行…」提示。 */
  connName?: string
  onClose: () => void
}

/**
 * SQL 文件批量执行对话框:选文件 → 预览(语句数) → 选错误策略 → 执行 → 进度/错误展示。
 * 语句切分 + 逐句执行 + 错误恢复在后端(sql_file.rs / db_run_sql_file,已单测);进度折叠
 * 在 sqlFileRun.ts(纯函数,已单测),这里只做对话框编排与事件订阅。
 */
export function SqlFileDialog({ connId, connName, onClose }: SqlFileDialogProps) {
  const { t } = useTranslation()
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<SqlFilePreview | null>(null)
  const [continueOnError, setContinueOnError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<SqlFileRunState | null>(null)
  // 当前执行的 executionId(用于取消)。
  const execIdRef = useRef<string | null>(null)
  // 在途 unlisten,卸载时清理。
  const unlistenRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { unlistenRef.current?.() }, [])

  async function pickFile() {
    setErr(null)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({
        multiple: false,
        filters: [{ name: t('dbviews.sqlFileFilter'), extensions: ['sql'] }],
      })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return
      setFilePath(path)
      setRun(null)
      setBusy(true)
      const pv = await sqlFilePreview(connId, path)
      setPreview(pv)
    } catch (e) {
      setErr(dbErrMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    if (!filePath) return
    setErr(null)
    setRun(initialRunState())
    setRunning(true)
    const executionId = (globalThis.crypto?.randomUUID?.() ?? `sqlfile-${Date.now()}-${Math.random()}`)
    execIdRef.current = executionId
    try {
      // 先挂监听,避免「Started」事件先于订阅丢失。
      const unlisten = await onSqlFileProgress(p => {
        if (p.executionId !== executionId) return
        setRun(prev => reduceProgress(prev ?? initialRunState(), p))
        if (isTerminalStatus(p.status)) {
          setRunning(false)
          unlistenRef.current?.()
          unlistenRef.current = null
        }
      })
      unlistenRef.current = unlisten
      await runSqlFile({ executionId, connId, filePath, continueOnError })
    } catch (e) {
      setErr(dbErrMsg(e))
      setRunning(false)
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }

  async function cancel() {
    const id = execIdRef.current
    if (id) await cancelSqlFile(id)
  }

  const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)' }
  const terminal = run != null && isTerminalStatus(run.status)
  const pct = run ? progressPercent(run) : 0

  return (
    <div onClick={running ? undefined : onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'color-mix(in srgb, var(--cta-bg) 42%, transparent)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="pop-in"
        style={{ width: 640, maxWidth: '92%', maxHeight: '88%', background: 'var(--surface-card)', borderRadius: 18, border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-window)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="row" style={{ justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid var(--border-hairline)', flex: 'none' }}>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>{t('dbviews.sqlFileTitle')}</span>
            {connName && <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{connName}</span>}
          </div>
          <IconBtn name="x" size={16} variant="bare" onClick={running ? () => { /* 执行中不可关闭 */ } : onClose} />
        </div>

        {/* body */}
        <div className="col" style={{ gap: 14, padding: '16px 20px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          {/* file picker */}
          <div className="col" style={{ gap: 6 }}>
            <span style={labelStyle}>{t('dbviews.sqlFileFile')}</span>
            <div className="row gap8" style={{ alignItems: 'center' }}>
              <Btn size="sm" variant="secondary" icon="upload" onClick={pickFile} disabled={busy || running}>
                {t('dbviews.sqlFileChoose')}
              </Btn>
              {preview && (
                <span className="mono ell" style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 0 }}>
                  {preview.fileName} · {t('dbviews.sqlFileStmtCount', { count: preview.statementCount })}
                </span>
              )}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('dbviews.sqlFileHint')}</span>
          </div>

          {/* error policy */}
          {preview && (
            <div className="col" style={{ gap: 6 }}>
              <span style={labelStyle}>{t('dbviews.sqlFileErrorPolicy')}</span>
              <div className="row gap8">
                {([false, true] as const).map(v => (
                  <button key={String(v)} className="row" onClick={() => setContinueOnError(v)} disabled={running}
                    style={{ gap: 6, padding: '6px 12px', borderRadius: 8, border: `1px solid ${continueOnError === v ? 'var(--accent-primary)' : 'var(--border-hairline-alt)'}`, background: continueOnError === v ? 'var(--accent-soft)' : 'transparent', color: continueOnError === v ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: running ? 'default' : 'pointer', fontSize: 12.5 }}>
                    <Icon name={v ? 'arrow-right' : 'square'} size={13} />
                    {t(v ? 'dbviews.sqlFileContinue' : 'dbviews.sqlFileAbort')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* progress */}
          {run && (
            <div className="col" style={{ gap: 8 }}>
              <span style={labelStyle}>{t('dbviews.sqlFileProgress')}</span>
              <div style={{ height: 8, borderRadius: 6, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: run.status === 'error' ? 'var(--danger, #d9534f)' : 'var(--accent-primary)', transition: 'width .15s' }} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                <span>{t('dbviews.sqlFileCounts', { done: run.statementIndex, total: run.total, ok: run.successCount, fail: run.failureCount })}</span>
                <span>{t('dbviews.sqlFileAffected', { count: run.affectedRows })}</span>
              </div>
              {running && run.currentStatement && (
                <span className="mono ell" style={{ fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 0 }}>{run.currentStatement}</span>
              )}
              {/* failures */}
              {run.errors.length > 0 && (
                <div className="col" style={{ gap: 4, border: '1px solid var(--border-hairline-alt)', borderRadius: 10, padding: '8px 10px', maxHeight: 160, overflow: 'auto' }}>
                  {run.errors.map((e, i) => (
                    <div key={i} className="col" style={{ gap: 2 }}>
                      <span className="mono ell" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>#{e.statementIndex} {e.summary}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--danger, #d9534f)' }}>{e.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* terminal banner */}
              {terminal && run.status === 'done' && (
                <div className="row gap8" style={{ alignItems: 'center', color: 'var(--accent-primary)', fontSize: 12.5 }}>
                  <Icon name="circle-check" size={14} />
                  <span>{t('dbviews.sqlFileDone', { ok: run.successCount, fail: run.failureCount })}</span>
                </div>
              )}
              {terminal && run.status === 'cancelled' && (
                <div className="row gap8" style={{ alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
                  <Icon name="square" size={14} />
                  <span>{t('dbviews.sqlFileCancelled')}</span>
                </div>
              )}
              {terminal && run.status === 'error' && (
                <div className="row gap8" style={{ alignItems: 'center', color: 'var(--danger, #d9534f)', fontSize: 12.5 }}>
                  <Icon name="alert-triangle" size={14} />
                  <span>{t('dbviews.sqlFileAborted')}</span>
                </div>
              )}
            </div>
          )}

          {err && (
            <div className="row gap8" style={{ alignItems: 'center', color: 'var(--danger, #d9534f)', fontSize: 12 }}>
              <Icon name="alert-triangle" size={14} />
              <span>{err}</span>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="row gap8" style={{ justifyContent: 'flex-end', padding: '14px 20px 18px', borderTop: '1px solid var(--border-hairline)', flex: 'none' }}>
          {running ? (
            <Btn variant="danger" icon="square" onClick={cancel}>{t('dbviews.sqlFileCancel')}</Btn>
          ) : (
            <>
              <Btn variant="ghost" onClick={onClose}>{terminal ? t('dbviews.close') : t('dbviews.cancel')}</Btn>
              <Btn variant="primary" icon="play" onClick={start} disabled={!preview || preview.statementCount === 0}>
                {t('dbviews.sqlFileRun', { count: preview?.statementCount ?? 0 })}
              </Btn>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
