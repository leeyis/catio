import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import type { Connection, SftpItem } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { sftpList, sftpRealpath, sftpMkdir, sftpTouch, sftpRename, sftpDelete } from '../../services/ssh'
import { useTransfers, startUpload, startDownload, cancelTransfer, onTransferDone } from '../../state/transfers'
import { getSftpNav, setSftpNav } from '../../state/sftpNav'
import { loadFavorites, toggleFavorite, COMMON_DIRS } from '../../state/sftpFavorites'

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

interface HoverState {
  item: SftpItem
  x: number
  y: number
}

// Compact size for the hover/select row actions. The default .icon-btn is 30px —
// taller than a list row — so revealing it on hover used to grow the row height.
const ACTION_BTN = { width: 18, height: 18 }

export interface SftpPanelProps {
  onClose: () => void
  conn?: Connection
  sessionId?: string
  /** Open a remote file in the editor (double-click / context menu). When absent, files download. */
  onEditFile?: (path: string) => void
}

export function SftpPanel({ onClose, conn, sessionId, onEditFile }: SftpPanelProps) {
  const { t } = useTranslation()

  // Seed from the per-session cache so reopening the panel restores the directory
  // the user was browsing (and its listing) instead of flashing back to home.
  const [items, setItems] = useState<SftpItem[]>(() => (sessionId ? getSftpNav(sessionId)?.items ?? [] : []))
  const [path, setPath] = useState<string>(() => (sessionId ? getSftpNav(sessionId)?.path ?? '' : ''))
  const [pathInput, setPathInput] = useState<string>(() => (sessionId ? getSftpNav(sessionId)?.path ?? '' : ''))
  // Path favorites + quick-jump dropdown (C1).
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites())
  const [jumpOpen, setJumpOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const transfers = useTransfers()
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
  const pathRef = useRef(sessionId ? getSftpNav(sessionId)?.path ?? '' : '')

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
        setSftpNav(sid, { path: p, items: list })
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
    // Already browsed this session? Restore where we were (covers switching the
    // active session while the panel stays mounted) instead of resetting to home.
    const cached = getSftpNav(sessionId)
    if (cached) {
      setItems(cached.items)
      setPath(cached.path)
      pathRef.current = cached.path
      setPathInput(cached.path)
      return
    }
    sftpRealpath(sessionId, '.')
      .then(abs => load(abs))
      .catch(() => load('.'))
  }, [sessionId, load])

  // ---- transfers ----
  // Transfer state + the Tauri progress/complete/cancel/error listeners live in the
  // global store (src/state/transfers.ts), NOT here — so an in-flight upload/download
  // survives this panel unmounting when the user switches tabs/panels. Here we only
  // reload the listing once a transfer that landed in the directory we're viewing finishes.
  useEffect(() => onTransferDone(dir => {
    if (dir === pathRef.current) load(pathRef.current)
  }), [load])

  const uploadLocal = useCallback(async (localPath: string) => {
    const sid = sessionRef.current
    if (!sid) return
    const dir = pathRef.current
    const name = baseName(localPath)
    try {
      await startUpload(sid, localPath, joinPath(dir, name), dir, name)
    } catch (e) {
      setError(String(e))
    }
  }, [])

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
        startDownload(sessionId, it.path, dest, pathRef.current, it.name).catch(e => setError(String(e)))
      })
    })
  }

  const openItem = (it: SftpItem) => {
    if (it.type === 'dir') load(it.path)
    // 双击文本文件进编辑器(二进制/超大由编辑器侧检测并回退下载);无 onEditFile 时退回直接下载。
    else if (it.type === 'file') { if (onEditFile) onEditFile(it.path); else downloadItem(it) }
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
  const jumpBoxRef = useRef<HTMLDivElement>(null)

  // Quick-jump: '~' resolves to the home dir (sftp default cwd); others go through goPath.
  const jumpTo = (p: string) => {
    setJumpOpen(false)
    if (p === '~') {
      if (sessionId) sftpRealpath(sessionId, '.').then(load).catch(e => setError(String(e)))
      return
    }
    goPath(p)
  }

  // Close the favorites menu only when clicking OUTSIDE it (mousedown + contains check),
  // or on Escape. Clicks on the bookmark button / inside the menu stay open so the
  // favorite-toggle feedback is visible. (The old window-click handler closed the menu on
  // the same click that opened it → looked like nothing happened.)
  useEffect(() => {
    if (!jumpOpen) return
    const onDown = (e: MouseEvent) => {
      if (jumpBoxRef.current && !jumpBoxRef.current.contains(e.target as Node)) setJumpOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setJumpOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [jumpOpen])

  // Keep favorites in sync if another window toggles them.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === 'catio-sftp-favorites') setFavorites(loadFavorites()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
          <div ref={jumpBoxRef} className="row gap6" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-hairline)', position: 'relative' }}>
            <IconBtn name="arrow-up" size={15} variant="bare" title={t('panels.sftpUp')} onClick={() => { if (!isRoot) load(parentPath(path)) }} style={{ opacity: isRoot ? 0.4 : 1 }} />
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
            <IconBtn name="bookmark" size={15} variant="bare" title={t('panels.sftpQuickJump')} onClick={() => setJumpOpen(o => !o)}
              style={{ color: jumpOpen || favorites.includes(path) ? 'var(--accent-primary)' : undefined }} />
            {jumpOpen && (
              <div style={{ position: 'absolute', right: 8, top: 42, zIndex: 60, minWidth: 250, maxHeight: 360, overflowY: 'auto', padding: 4, borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', boxShadow: 'var(--shadow-dropdown)' }}>
                {/* 顶部:明确的「收藏/取消收藏当前目录」动作,带当前目录名 */}
                <button onClick={() => { if (path) setFavorites(toggleFavorite(path)) }} disabled={!path}
                  className="row" style={{ width: '100%', gap: 8, alignItems: 'center', padding: '8px', borderRadius: 7, border: 'none', background: 'transparent', cursor: path ? 'pointer' : 'default', textAlign: 'left' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-soft)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="star" size={14} style={{ color: favorites.includes(path) ? 'var(--signal-amber)' : 'var(--text-tertiary)', flex: 'none' }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 'none' }}>{favorites.includes(path) ? t('panels.sftpFavRemoveCurrent') : t('panels.sftpFavAddCurrent')}</span>
                  <span className="ell mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-faint)', textAlign: 'right' }}>{baseName(path) || path || '/'}</span>
                </button>
                <div style={{ height: 1, margin: '4px 0', background: 'var(--border-hairline)' }} />
                {/* 收藏夹 */}
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', padding: '4px 8px' }}>{t('panels.sftpFavorites')}</div>
                {favorites.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '2px 8px 6px' }}>{t('panels.sftpFavEmpty')}</div>}
                {favorites.map(p => (
                  <div key={`fav:${p}`} className="row" style={{ alignItems: 'center', gap: 2 }}>
                    <button onClick={() => jumpTo(p)} className="ell mono"
                      style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '6px 8px', fontSize: 12, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', borderRadius: 7 }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-soft)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{p}</button>
                    <IconBtn name="x" size={11} variant="bare" title={t('panels.sftpUnfavorite')} onClick={() => setFavorites(toggleFavorite(p))} />
                  </div>
                ))}
                {/* 常用目录 */}
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', padding: '4px 8px' }}>{t('panels.sftpCommonDirs')}</div>
                {COMMON_DIRS.filter(p => !favorites.includes(p)).map(p => (
                  <button key={`common:${p}`} onClick={() => jumpTo(p)} className="ell mono"
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 12, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', borderRadius: 7 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-soft)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{p}</button>
                ))}
              </div>
            )}
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
                    {tr.status === 'active' && (
                      <IconBtn name="x" size={12} variant="bare" title={t('panels.sftpCancelTransfer')} onClick={() => { cancelTransfer(tr.id); load(pathRef.current) }} />
                    )}
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
                    {/* row actions — discoverable on hover/select. Always mounted and
                        toggled via opacity (not conditional render) so revealing them
                        never changes the row height. */}
                    <div className="row gap4" onMouseDown={e => e.stopPropagation()}
                      style={{
                        flex: 'none', transition: 'opacity .12s',
                        opacity: hover?.item.path === it.path || selected === it.path ? 1 : 0,
                        pointerEvents: hover?.item.path === it.path || selected === it.path ? 'auto' : 'none',
                      }}>
                      {it.type === 'file' && (
                        <IconBtn name="download" size={13} variant="bare" style={ACTION_BTN} title={t('panels.sftpDownload')} onClick={e => { e.stopPropagation(); downloadItem(it) }} />
                      )}
                      <IconBtn name="pencil" size={13} variant="bare" style={ACTION_BTN} title={t('panels.sftpRename')} onClick={e => { e.stopPropagation(); startRename(it) }} />
                      <IconBtn name="trash-2" size={13} variant="bare" style={ACTION_BTN} title={t('panels.sftpDelete')} onClick={e => { e.stopPropagation(); setHover(null); setDeleteConfirm(it) }} />
                    </div>
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
              {ctxMenu.item.type === 'file' && onEditFile && (
                <CtxItem icon="file-code" label={t('remoteFile.openInEditor')} onClick={() => { const it = ctxMenu.item; setCtxMenu(null); onEditFile(it.path) }} />
              )}
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
