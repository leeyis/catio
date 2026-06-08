/* ported from ref-ui/_extract/blob9.txt — verbatim per plan T1-T7 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import type { Connection, Sftp, SftpItem } from '../../services/types'
import { PanelShell } from './PanelShell'
import { PanelEmpty } from './PanelEmpty'
import { getSftp, sftpUpload, sftpDownload, listen } from '../../services/ssh'

function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

function posixJoin(base: string, name: string): string {
  const b = base === '.' ? '' : base.replace(/\/$/, '')
  return b ? `${b}/${name}` : name
}

function posixParent(p: string): string {
  if (p === '.' || p === '' || p === '/') return '.'
  const trimmed = p.replace(/\/$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return '.'
  return trimmed.slice(0, slash)
}

function posixBasename(p: string): string {
  const trimmed = p.replace(/\/$/, '')
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

export interface SftpPanelProps {
  onClose: () => void
  conn?: Connection
  sessionId?: string
}

export function SftpPanel({ onClose, conn, sessionId }: SftpPanelProps) {
  const { t } = useTranslation()

  const EMPTY_SFTP: Sftp = { path: '', items: [] }
  const [sftp, setSftp] = useState<Sftp>(EMPTY_SFTP)
  const [path, setPath] = useState<string>('')

  const load = useCallback((p: string) => {
    if (!sessionId) return
    getSftp(sessionId, p).then(result => {
      setSftp(result)
      setPath(result.path)
    }).catch(() => {
      // On error keep current state (e.g. no session yet)
    })
  }, [sessionId])

  useEffect(() => {
    if (sessionId) {
      load(path || '.')
    } else {
      setSftp(EMPTY_SFTP)
      setPath('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleItemClick = (it: SftpItem) => {
    if (!sessionId || !isTauriEnv()) return
    if (it.type === 'dir') {
      const next = posixJoin(path, it.name)
      load(next)
    } else if (it.type === 'up') {
      const next = posixParent(path)
      load(next)
    } else if (it.type === 'file') {
      // Download on file click (Tauri only)
      import('@tauri-apps/plugin-dialog').then(({ save }) => {
        save({ defaultPath: it.name }).then(dest => {
          if (!dest) return
          const remote = posixJoin(path, it.name)
          sftpDownload(sessionId, remote, dest).then(() => load(path))
        })
      })
    }
  }

  const handleUpload = () => {
    if (!sessionId || !isTauriEnv()) return
    import('@tauri-apps/plugin-dialog').then(({ open }) => {
      open({ multiple: false }).then(picked => {
        if (!picked) return
        const localPath = typeof picked === 'string' ? picked : picked
        const remotePath = posixJoin(path, posixBasename(localPath))
        // Subscribe to upload progress; reload on completion
        const progressPromise = listen<{ done: number; total: number }>('sftp-progress://upload', () => {
          // No visual indicator added — progress deferred (no clean spot in layout)
        })
        sftpUpload(sessionId, localPath, remotePath).then(() => {
          progressPromise.then(unlisten => unlisten())
          load(path)
        }).catch(() => {
          progressPromise.then(unlisten => unlisten())
        })
      })
    })
  }

  const handleRefresh = () => {
    load(path)
  }

  // Build displayed items: synthetic '..' entry (only when not at root) + real items
  const isRoot = path === '.' || path === '' || path === '/'
  const displayItems: SftpItem[] = isRoot
    ? sftp.items
    : [{ name: '..', type: 'up' as const }, ...sftp.items]

  return (
    <PanelShell icon="folder" title={`SFTP · ${conn ? conn.name : 'prod-web-01'}`} sub={sessionId ? sftp.path : undefined} onClose={onClose}
      actions={<><IconBtn name="upload" size={15} variant="bare" title={t('panels.upload')} onClick={handleUpload} /><IconBtn name="refresh-cw" size={15} variant="bare" title={t('panels.refresh')} onClick={handleRefresh} /></>}>
      {!sessionId ? (
        <PanelEmpty icon="folder" text={t('panels.noSessionHint')} />
      ) : (
        <>
          <div className="row gap6" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
            <Icon name="folder-open" size={13} style={{ color: 'var(--signal-amber)' }} />
            <span className="mono ell">{sftp.path}</span>
          </div>
          <div className="grow" style={{ overflowY: 'auto', padding: 6 }}>
            {displayItems.map((it, i) => (
              <div key={i} className="row gap8" style={{ padding: '7px 8px', borderRadius: 8, cursor: 'pointer' }}
                onClick={() => handleItemClick(it)}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-sunken)'} onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}>
                <Icon name={it.type === 'up' ? 'corner-down-right' : it.type === 'dir' ? 'folder' : it.name.endsWith('.log') ? 'file' : it.name.endsWith('.js') || it.name.endsWith('.json') ? 'file-code' : 'file'}
                  size={15} style={{ color: it.type === 'dir' ? 'var(--signal-amber)' : it.type === 'up' ? 'var(--text-faint)' : 'var(--text-tertiary)', flex: 'none' }} />
                <span className="ell mono" style={{ fontSize: 12.5, color: it.type === 'up' ? 'var(--text-faint)' : 'var(--text-secondary)', flex: 1 }}>{it.name}</span>
                {it.size && it.type !== 'up' && <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{it.size}</span>}
                {it.mod && it.type !== 'up' && <span style={{ fontSize: 10.5, color: 'var(--text-disabled)', width: 48, textAlign: 'right' }}>{it.mod}</span>}
              </div>
            ))}
          </div>
          <div className="row gap8" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-hairline)', fontSize: 11, color: 'var(--text-faint)' }}>
            <Icon name="info" size={12} /> {t('panels.sftpDropHint')}
          </div>
        </>
      )}
    </PanelShell>
  )
}
