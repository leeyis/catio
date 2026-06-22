/* KV 引擎(Redis)的"结构"面板:Redis 没有表结构/DDL,改为展示该逻辑库的 key
   元信息 —— 键总数(DBSIZE) + 采样得到的类型分布(string/hash/list/set/zset/…)。
   数据来自后端 db_keyspace_info(采样 TYPE 统计)。 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { keyspaceInfo, dbErrMsg, type KeyspaceInfo } from '../../services/db'

export interface RedisKeyspaceViewProps {
  connId?: string
  schema?: string
}

// 各 Redis 数据类型的配色(沿用全局 signal 调色板,主题切换自动适配)。
const TYPE_TONE: Record<string, string> = {
  string: 'var(--signal-blue)',
  hash: 'var(--signal-violet)',
  list: 'var(--signal-green)',
  set: 'var(--signal-amber)',
  zset: 'var(--accent-primary)',
  stream: 'var(--signal-rose)',
}

export function RedisKeyspaceView({ connId, schema }: RedisKeyspaceViewProps) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<KeyspaceInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!connId) { setInfo(null); setErr(null); return }
    let cancelled = false
    setErr(null)
    setLoading(true)
    keyspaceInfo(connId, schema ?? '')
      .then(i => { if (!cancelled) setInfo(i) })
      .catch(e => { if (!cancelled) setErr(dbErrMsg(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, schema])

  if (err) {
    return (
      <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-faint)' }}>
        <Icon name="alert-triangle" size={26} /><span style={{ fontSize: 13 }}>{err}</span>
      </div>
    )
  }
  if (loading || !info) {
    return (
      <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-faint)' }}>
        <Icon name="loader" size={22} style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    )
  }

  const sampledNote = info.totalKeys > info.sampled
  const maxCount = info.types.reduce((m, t) => Math.max(m, t.count), 0)

  return (
    <div className="col" style={{ height: '100%', overflow: 'auto', padding: '16px 18px', gap: 18 }}>
      {/* 顶部统计:键总数 + 采样说明 */}
      <div className="row gap8" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('dbviews.keyspaceTotal')}</span>
        <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{info.totalKeys.toLocaleString()}</span>
        {sampledNote && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('dbviews.keyspaceSampled', { n: info.sampled.toLocaleString() })}</span>
        )}
      </div>

      {/* 类型分布 */}
      {info.types.length === 0 ? (
        <div className="col" style={{ alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-faint)' }}>
          <Icon name="database" size={24} /><span style={{ fontSize: 13 }}>{t('dbviews.keyspaceEmpty')}</span>
        </div>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 2 }}>{t('dbviews.keyspaceTypes')}</span>
          {info.types.map(ty => {
            const tone = TYPE_TONE[ty.name] ?? 'var(--text-tertiary)'
            const pct = maxCount > 0 ? (ty.count / maxCount) * 100 : 0
            const share = info.sampled > 0 ? Math.round((ty.count / info.sampled) * 100) : 0
            return (
              <div key={ty.name} className="row gap8" style={{ alignItems: 'center' }}>
                <span className="mono" style={{ width: 64, flex: 'none', fontSize: 12, fontWeight: 600, color: tone }}>{ty.name}</span>
                <div style={{ flex: 1, height: 16, borderRadius: 5, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: `color-mix(in srgb, ${tone} 65%, transparent)`, transition: 'width .2s' }} />
                </div>
                <span className="mono" style={{ width: 56, flex: 'none', textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>{ty.count.toLocaleString()}</span>
                <span className="mono" style={{ width: 40, flex: 'none', textAlign: 'right', fontSize: 11, color: 'var(--text-faint)' }}>{share}%</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
