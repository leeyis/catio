import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import type { Connection, SftpItem, TransferProgress } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { sftpList, sftpRealpath, sftpUpload, sftpDownload, sftpMkdir, sftpTouch, sftpRename, sftpDelete, listen } from '../../services/ssh'

function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

// ---- pure path helpers (absolute POSIX paths) ----
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}
function parentPath(p: string): string {
  if (p === '/' || p === '') return '/'
  const t = p.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i <= 0 ? '/' : t.slice(0, i)
}
function baseName(p: string): string {
  const segs = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return segs[segs.length - 1] || p
}

// ---- pure formatters ----
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
function fmtDate(epoch: number): string {
  if (!epoch) return '—'
  const d = new Date(epoch * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 1) return ''
  return `${fmtSize(bytesPerSec)}/s`
}

interface ActiveTransfer {
  id: string
  filename: string
  percent: number
  /** Instantaneous transfer rate in bytes/sec (derived from progress deltas). */
  speed: number
  status: 'active' | 'error'
  kind: 'up' | 'down'
}

interface HoverState {
  item: SftpItem
  x: number
  y: number
}

export interface SftpPanelProps {
  onClose: () => void
  conn?: Connection
  sessionId?: string
}

export function SftpPanel({ onClose, conn, sessionId }: SftpPanelProps) {
  const { t } = useTranslation()

  const [items, setItems] = useState<SftpItem[]>([])
  const [path, setPath] = useState<string>('')
  const [pathInput, setPathInput] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [transfers, setTransfers] = useState<ActiveTransfer[]>([])
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState<HoverState | null>(null)
  // file operations (create / rename / delete / context menu)
  const [creating, setCreating] = useState<null | 'dir' | 'file'>(null)
  const [createName, setCreateName] = useState('')
  const [renaming, setRenaming] = useState<{ path: string; newName: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: SftpItem } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<SftpItem | null>(null)

  // refs so the once-mounted drag-drop listener always sees the latest values.
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const pathRef = useRef('')
  // last progress sample per transfer, for computing speed.
  const sampleRef = useRef<Record<string, { bytes: number; time: number }>>({})

  const load = useCallback((p: string) => {
    const sid = sessionRef.current
    if (!sid) return
    setLoading(true)
    setError(null)
    sftpList(sid, p)
      .then(list => {
        setItems(list)
        setPath(p)
        pathRef.current = p
        setPathInput(p)
        setSelected(null)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Resolve home ('.') to an absolute path on (re)connect, then list it.
  useEffect(() => {
    if (!sessionId) {
      setItems([])
      setPath('')
      pathRef.current = ''
      setPathInput('')
      return
    }
    sftpRealpath(sessionId, '.')
      .then(abs => load(abs))
      .catch(() => load('.'))
  }, [sessionId, load])

  // ---- transfers ----
  const trackTransfer = useCallback(async (id: string, filename: string, kind: 'up' | 'down') => {
    setTransfers(prev => [...prev, { id, filename, percent: 0, speed: 0, status: 'active', kind }])
    const offs: Array<() => void> = []
    const cleanup = () => { offs.forEach(f => f()); delete sampleRef.current[id] }
    offs.push(await listen<TransferProgress>(`transfer-progress-${id}`, p => {
      const now = Date.now()
      const prev = sampleRef.current[id]
      // Refresh the displayed speed at most once per second (otherwise it flickers
      // on every 256KiB progress event). The bar/percent still update every event.
      let nextSpeed: number | undefined
      if (!prev) {
        sampleRef.current[id] = { bytes: p.bytesTransferred, time: now }
      } else if (now - prev.time >= 1000) {
        nextSpeed = (p.bytesTransferred - prev.bytes) / ((now - prev.time) / 1000)
        sampleRef.current[id] = { bytes: p.bytesTransferred, time: now }
      }
      setTransfers(prevT => prevT.map(x => (x.id === id
        ? { ...x, percent: p.percent, speed: nextSpeed !== undefined ? nextSpeed : x.speed }
        : x)))
    }))
    offs.push(await listen(`transfer-complete-${id}`, () => {
      cleanup()
      setTransfers(prev => prev.filter(x => x.id !== id))
      load(pathRef.current)
    }))
    offs.push(await listen<string>(`transfer-error-${id}`, msg => {
      cleanup()
      setTransfers(prev => prev.map(x => (x.id === id ? { ...x, status: 'error' } : x)))
      setError(typeof msg === 'string' ? msg : 'transfer failed')
      // drop the errored row after a short delay
      setTimeout(() => setTransfers(prev => prev.filter(x => x.id !== id)), 4000)
    }))
  }, [load])

  const uploadLocal = useCallback(async (localPath: string) => {
    const sid = sessionRef.current
    if (!sid) return
    const remote = joinPath(pathRef.current, baseName(localPath))
    try {
      const id = await sftpUpload(sid, localPath, remote)
      await trackTransfer(id, baseName(localPath), 'up')
    } catch (e) {
      setError(String(e))
    }
  }, [trackTransfer])

  const handleDrop = useCallback(async (paths: string[]) => {
    if (!sessionRef.current || paths.length === 0) return
    for (const p of paths) {
      // skip directories silently (only files are uploaded)
      await uploadLocal(p)
    }
  }, [uploadLocal])

  // Native (OS) drag-and-drop — Tauri intercepts file drops, so HTML5 ondrop
  // never fires; we must use the webview drag-drop event instead.
  useEffect(() => {
    if (!isTauriEnv()) return
    let un: (() => void) | undefined
    let alive = true
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
      getCurrentWebview()
        .onDragDropEvent(ev => {
          const ty = ev.payload.type
          if (ty === 'enter' || ty === 'over') setDragging(true)
          else if (ty === 'leave') setDragging(false)
          else if (ty === 'drop') {
            setDragging(false)
            void handleDrop(ev.payload.paths)
          }
        })
        .then(u => { if (alive) un = u; else u() })
    })
    return () => { alive = false; un?.() }
  }, [handleDrop])

  // ---- actions ----
  const handleUploadClick = () => {
    if (!sessionId || !isTauriEnv()) return
    import('@tauri-apps/plugin-dialog').then(({ open }) => {
      open({ multiple: true }).then(picked => {
        if (!picked) return
        const arr = Array.isArray(picked) ? picked : [picked]
        void (async () => { for (const p of arr) await uploadLocal(p as string) })()
      })
    })
  }

  const downloadItem = (it: SftpItem) => {
    if (!sessionId || !isTauriEnv()) return
    import('@tauri-apps/plugin-dialog').then(({ save }) => {
      save({ defaultPath: it.name }).then(dest => {
        if (!dest) return
        sftpDownload(sessionId, it.path, dest).then(id => trackTransfer(id, it.name, 'down')).catch(e => setError(String(e)))
      })
    })
  }

  const openItem = (it: SftpItem) => {
    if (it.type === 'dir') load(it.path)
    else if (it.type === 'file') downloadItem(it)
  }

  const goPath = (raw: string) => {
    const p = raw.trim()
    if (!p) return
    load(p.startsWith('/') ? p : `/${p}`)
  }

  // ---- create / rename / delete (ported from Reach's FileExplorer) ----
  const startCreate = (kind: 'dir' | 'file') => {
    if (!sessionId) return
    setRenaming(null)
    setCreating(kind)
    setCreateName('')
  }
  const commitCreate = () => {
    const kind = creating
    const name = createName.trim()
    setCreating(null)
    setCreateName('')
    if (!sessionId || !kind || !name) return
    const target = joinPath(pathRef.current, name)
    const op = kind === 'dir' ? sftpMkdir(sessionId, target) : sftpTouch(sessionId, target)
    op.then(() => load(pathRef.current)).catch(e => setError(String(e)))
  }
  const startRename = (it: SftpItem) => {
    setCtxMenu(null)
    setRenaming({ path: it.path, newName: it.name })
  }
  const commitRename = () => {
    const r = renaming
    setRenaming(null)
    if (!sessionId || !r) return
    const trimmed = r.newName.trim()
    if (!trimmed || trimmed === baseName(r.path)) return
    const newPath = joinPath(parentPath(r.path), trimmed)
    sftpRename(sessionId, r.path, newPath).then(() => load(pathRef.current)).catch(e => setError(String(e)))
  }
  const confirmDelete = () => {
    const it = deleteConfirm
    setDeleteConfirm(null)
    if (!sessionId || !it) return
    sftpDelete(sessionId, it.path, it.type === 'dir').then(() => load(pathRef.current)).catch(e => setError(String(e)))
  }

  // close the context menu on any outside click / escape
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [ctxMenu])

  const isRoot = path === '/' || path === ''

  return (
    <PanelShell
      icon="folder"
      title={`${t('panels.sftpTitle')} · ${conn ? conn.name : (path ? baseName(path) || '/' : t('panels.sftpTitle'))}`}
      sub={sessionId ? path : undefined}
      onClose={onClose}
      actions={sessionId ? <>
        <IconBtn name="folder" size={15} variant="bare" title={t('panels.sftpNewFolder')} onClick={() => startCreate('dir')} />
        <IconBtn name="file" size={15} variant="bare" title={t('panels.sftpNewFile')} onClick={() => startCreate('file')} />
        <IconBtn name="upload" size={15} variant="bare" title={t('panels.upload')} onClick={handleUploadClick} />
        <IconBtn name="refresh-cw" size={15} variant="bare" title={t('panels.refresh')} onClick={() => load(path || '.')} />
      </> : undefined}
    >
      {!sessionId ? (
        <PanelEmpty icon="folder" text={t('panels.noSessionHint')} />
      ) : (
        <>
          {/* address bar */}
          <div className="row gap6" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-hairline)' }}>
            <IconBtn name="chevron-up" size={15} variant="bare" title={t('panels.sftpUp')} onClick={() => { if (!isRoot) load(parentPath(path)) }} style={{ opacity: isRoot ? 0.4 : 1 }} />
            <input
              className="mono"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') goPath(pathInput); if (e.key === 'Escape') setPathInput(path) }}
              placeholder={t('panels.sftpAddressPlaceholder')}
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, height: 28, padding: '0 10px', fontSize: 12,
                color: 'var(--text-secondary)', background: 'var(--surface-sunken)',
                border: '1px solid var(--border-hairline)', borderRadius: 8, outline: 'none',
              }}
            />
          </div>

          {/* active transfers */}
          {transfers.length > 0 && (
            <div className="col" style={{ padding: '8px 12px', gap: 8, borderBottom: '1px solid var(--border-hairline)' }}>
              {transfers.map(tr => (
                <div key={tr.id} className="col" style={{ gap: 4 }}>
                  <div className="row gap6" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <Icon name={tr.kind === 'up' ? 'upload' : 'download'} size={11} />
                    <span className="ell" style={{ flex: 1 }}>{tr.filename}</span>
                    {tr.status !== 'error' && tr.speed > 0 && (
                      <span className="mono" style={{ color: 'var(--text-faint)' }}>{fmtSpeed(tr.speed)}</span>
                    )}
                    <span className="mono">{tr.status === 'error' ? '!' : `${Math.round(tr.percent)}%`}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 4, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${tr.percent}%`, background: tr.status === 'error' ? 'var(--signal-red, #e5484d)' : 'var(--accent-primary)', transition: 'width .15s' }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="row gap6" style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--signal-red, #e5484d)', borderBottom: '1px solid var(--border-hairline)' }}>
              <Icon name="alert-triangle" size={12} /> <span className="ell">{error}</span>
            </div>
          )}

          {deleteConfirm && (
            <div className="col" style={{ padding: '8px 12px', gap: 8, borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{t('panels.sftpDeleteConfirm', { name: deleteConfirm.name })}</span>
              <div className="row gap6" style={{ justifyContent: 'flex-end' }}>
                <button className="icon-btn bare" style={{ width: 'auto', padding: '4px 10px', fontSize: 11.5 }} onClick={() => setDeleteConfirm(null)}>{t('panels.sftpCancel')}</button>
                <button className="icon-btn bare" style={{ width: 'auto', padding: '4px 10px', fontSize: 11.5, color: 'var(--signal-red, #e5484d)', fontWeight: 600 }} onClick={confirmDelete}>{t('panels.sftpDelete')}</button>
              </div>
            </div>
          )}

          {/* file list */}
          <div className="grow" style={{ position: 'relative', overflowY: 'auto', padding: 6 }}>
            {dragging && (
              <div className="col" style={{
                position: 'absolute', inset: 6, zIndex: 20, borderRadius: 12,
                border: '2px dashed var(--accent-primary)', background: 'var(--accent-soft)',
                alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--accent-primary)',
                pointerEvents: 'none',
              }}>
                <Icon name="upload" size={24} />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('panels.sftpDropToUpload')}</span>
              </div>
            )}

            {/* inline new folder / new file row */}
            {creating && (
              <div className="row gap8" style={{ padding: '5px 8px' }}>
                <Icon name={creating === 'dir' ? 'folder' : 'file'} size={15} style={{ color: creating === 'dir' ? 'var(--signal-amber)' : 'var(--text-tertiary)', flex: 'none' }} />
                <input autoFocus className="mono" value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') { setCreating(null); setCreateName('') } }}
                  onBlur={commitCreate}
                  placeholder={creating === 'dir' ? t('panels.sftpFolderName') : t('panels.sftpFileName')}
                  spellCheck={false}
                  style={{ flex: 1, minWidth: 0, height: 24, padding: '0 8px', fontSize: 12.5, color: 'var(--text-primary)', background: 'var(--surface-sunken)', border: '1px solid var(--accent-primary)', borderRadius: 6, outline: 'none' }} />
              </div>
            )}

            {items.length === 0 && !loading && !creating ? (
              <div className="col" style={{ alignItems: 'center', justifyContent: 'center', padding: '32px 12px', color: 'var(--text-faint)', fontSize: 12 }}>
                {t('panels.sftpEmptyDir')}
              </div>
            ) : (
              items.map((it, i) => (
                renaming && renaming.path === it.path ? (
                  <div key={`${it.path}-${i}`} className="row gap8" style={{ padding: '5px 8px' }}>
                    <Icon name={it.type === 'dir' ? 'folder' : it.type === 'link' ? 'file-code' : 'file'} size={15} style={{ color: it.type === 'dir' ? 'var(--signal-amber)' : 'var(--text-tertiary)', flex: 'none' }} />
                    <input autoFocus className="mono" value={renaming.newName}
                      onChange={e => setRenaming(r => (r ? { ...r, newName: e.target.value } : r))}
                      onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
                      onBlur={commitRename}
                      spellCheck={false}
                      style={{ flex: 1, minWidth: 0, height: 24, padding: '0 8px', fontSize: 12.5, color: 'var(--text-primary)', background: 'var(--surface-sunken)', border: '1px solid var(--accent-primary)', borderRadius: 6, outline: 'none' }} />
                  </div>
                ) : (
                  <div key={`${it.path}-${i}`} className="row gap8"
                    style={{ padding: '7px 8px', borderRadius: 8, cursor: 'pointer', background: selected === it.path ? 'var(--surface-sunken)' : 'transparent' }}
                    onClick={() => setSelected(it.path)}
                    onDoubleClick={() => openItem(it)}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setHover(null); setSelected(it.path); setCtxMenu({ x: e.clientX, y: e.clientY, item: it }) }}
                    onMouseEnter={e => { setHover({ item: it, x: e.clientX, y: e.clientY }); (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-sunken)' }}
                    onMouseMove={e => setHover(h => (h && h.item.path === it.path ? { item: it, x: e.clientX, y: e.clientY } : h))}
                    onMouseLeave={e => { setHover(null); (e.currentTarget as HTMLDivElement).style.background = selected === it.path ? 'var(--surface-sunken)' : 'transparent' }}
                  >
                    <Icon name={it.type === 'dir' ? 'folder' : it.type === 'link' ? 'file-code' : 'file'}
                      size={15} style={{ color: it.type === 'dir' ? 'var(--signal-amber)' : 'var(--text-tertiary)', flex: 'none' }} />
                    <span className="ell mono" style={{ fontSize: 12.5, color: 'var(--text-secondary)', flex: 1 }}>{it.name}</span>
                    {/* row actions — visible on hover/select so they are discoverable (no right-click needed) */}
                    {(hover?.item.path === it.path || selected === it.path) && (
                      <div className="row gap4" style={{ flex: 'none' }} onMouseDown={e => e.stopPropagation()}>
                        {it.type === 'file' && (
                          <IconBtn name="download" size={13} variant="bare" title={t('panels.sftpDownload')} onClick={e => { e.stopPropagation(); downloadItem(it) }} />
                        )}
                        <IconBtn name="pencil" size={13} variant="bare" title={t('panels.sftpRename')} onClick={e => { e.stopPropagation(); startRename(it) }} />
                        <IconBtn name="trash-2" size={13} variant="bare" title={t('panels.sftpDelete')} onClick={e => { e.stopPropagation(); setHover(null); setDeleteConfirm(it) }} />
                      </div>
                    )}
                  </div>
                )
              ))
            )}
          </div>

          {/* hover tooltip: detail moved off the row, shown on hover */}
          {hover && (
            <div style={{
              position: 'fixed', left: Math.min(hover.x + 14, window.innerWidth - 220), top: hover.y + 12,
              zIndex: 60, pointerEvents: 'none', minWidth: 168, maxWidth: 240,
              padding: '8px 10px', borderRadius: 10, fontSize: 11,
              background: 'var(--surface-overlay, var(--surface-card))', color: 'var(--text-secondary)',
              border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)',
            }}>
              <div className="ell" style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{hover.item.name}</div>
              <TipRow label={t('panels.sftpTipModified')} value={fmtDate(hover.item.modified)} />
              {hover.item.type === 'file' && <TipRow label={t('panels.sftpTipSize')} value={fmtSize(hover.item.size)} />}
              <TipRow label={t('panels.sftpTipPerms')} value={hover.item.permissions || '—'} mono />
              <TipRow label={t('panels.sftpTipOwner')} value={hover.item.owner || '—'} />
              <TipRow label={t('panels.sftpTipGroup')} value={hover.item.group || '—'} />
            </div>
          )}

          {/* right-click context menu */}
          {ctxMenu && (
            <div
              onClick={e => e.stopPropagation()}
              style={{
                position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 160), top: ctxMenu.y,
                zIndex: 70, minWidth: 144, padding: 4, borderRadius: 10,
                background: 'var(--surface-overlay, var(--surface-card))',
                border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-card)',
              }}>
              {ctxMenu.item.type === 'file' && (
                <CtxItem icon="download" label={t('panels.sftpDownload')} onClick={() => { const it = ctxMenu.item; setCtxMenu(null); downloadItem(it) }} />
              )}
              <CtxItem icon="pencil" label={t('panels.sftpRename')} onClick={() => startRename(ctxMenu.item)} />
              <CtxItem icon="trash-2" label={t('panels.sftpDelete')} danger onClick={() => { const it = ctxMenu.item; setCtxMenu(null); setDeleteConfirm(it) }} />
            </div>
          )}

          <div className="row gap8" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-hairline)', fontSize: 11, color: 'var(--text-faint)' }}>
            <Icon name="info" size={12} /> {t('panels.sftpDropHint')}
          </div>
        </>
      )}
    </PanelShell>
  )
}

function CtxItem({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="row gap8"
      style={{
        width: '100%', padding: '7px 10px', border: 'none', borderRadius: 7, cursor: 'pointer',
        background: 'transparent', fontSize: 12.5, textAlign: 'left',
        color: danger ? 'var(--signal-red, #e5484d)' : 'var(--text-secondary)',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-sunken)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon name={icon} size={14} style={{ flex: 'none' }} /> {label}
    </button>
  )
}

function TipRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row gap8" style={{ justifyContent: 'space-between', lineHeight: 1.6 }}>
      <span style={{ color: 'var(--text-faint)', flex: 'none' }}>{label}</span>
      <span className={mono ? 'mono ell' : 'ell'} style={{ textAlign: 'right' }}>{value}</span>
    </div>
  )
}
