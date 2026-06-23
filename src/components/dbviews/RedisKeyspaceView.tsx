/* KV 引擎(Redis)的"结构"面板:Redis 没有表结构/DDL,改为展示该逻辑库的 key
   元信息 —— 键总数(DBSIZE) + 采样得到的类型分布(string/hash/list/set/zset/…)。
   数据来自后端 db_keyspace_info(采样 TYPE 统计)。 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { keyspaceInfo, redisEdit, dbErrMsg, type KeyspaceInfo } from '../../services/db'
import { buildRedisEditArgs, type RedisEdit } from './redisEdit'

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

// 编辑操作类型(与 redisEdit.ts 的 RedisEdit.kind 对齐)。
type EditOp = RedisEdit['kind']
const EDIT_OPS: EditOp[] = [
  'setString', 'hashSet', 'hashDel', 'listPush', 'listSet',
  'setAdd', 'setRem', 'zadd', 'zrem', 'setTtl', 'delKey',
]
// 每个操作对应的 i18n label key。
const OP_LABEL: Record<EditOp, string> = {
  setString: 'redisOpSetString', hashSet: 'redisOpHashSet', hashDel: 'redisOpHashDel',
  listPush: 'redisOpListPush', listSet: 'redisOpListSet', setAdd: 'redisOpSetAdd',
  setRem: 'redisOpSetRem', zadd: 'redisOpZadd', zrem: 'redisOpZrem',
  delKey: 'redisOpDelKey', setTtl: 'redisOpSetTtl',
}

export function RedisKeyspaceView({ connId, schema }: RedisKeyspaceViewProps) {
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
    <RedisKeyspaceBody
      connId={connId}
      info={info}
      sampledNote={sampledNote}
      maxCount={maxCount}
    />
  )
}

// 把"摘要展示 + 键编辑器"拆成内部组件,让编辑器自己的状态(key/op/字段)集中管理,
// 避免污染外层数据加载逻辑;摘要部分原样保留作为只读查看态。
function RedisKeyspaceBody({
  connId, info, sampledNote, maxCount,
}: { connId?: string; info: KeyspaceInfo; sampledNote: boolean; maxCount: number }) {
  const { t } = useTranslation()
  const [key, setKey] = useState('')
  const [op, setOp] = useState<EditOp>('setString')
  const [value, setValue] = useState('')
  const [field, setField] = useState('')
  const [member, setMember] = useState('')
  const [score, setScore] = useState('')
  const [index, setIndex] = useState('')
  const [ttl, setTtl] = useState('')
  const [editErr, setEditErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  // 按当前操作类型拼出 RedisEdit。字段缺省取空串/0(由后端/纯函数兜底校验)。
  function buildEdit(): RedisEdit {
    switch (op) {
      case 'setString': return { kind: 'setString', key, value }
      case 'hashSet': return { kind: 'hashSet', key, field, value }
      case 'hashDel': return { kind: 'hashDel', key, field }
      case 'listPush': return { kind: 'listPush', key, value }
      case 'listSet': return { kind: 'listSet', key, index: Number(index) || 0, value }
      case 'setAdd': return { kind: 'setAdd', key, member }
      case 'setRem': return { kind: 'setRem', key, member }
      case 'zadd': return { kind: 'zadd', key, member, score: Number(score) || 0 }
      case 'zrem': return { kind: 'zrem', key, member }
      case 'delKey': return { kind: 'delKey', key }
      case 'setTtl': return { kind: 'setTtl', key, ttl: Number(ttl) || 0 }
    }
  }

  async function apply() {
    if (!connId) return
    setEditErr(null); setDone(false)
    const edit = buildEdit()
    // 前端先用纯函数校验(空 key 等),失败直接提示,不打后端。
    try { buildRedisEditArgs(edit) } catch (e) { setEditErr(dbErrMsg(e)); return }
    // 删除整个 key 不可恢复:先弹确认,取消则不执行;确认后带 confirm=true 调后端。
    const isDel = edit.kind === 'delKey'
    if (isDel && !window.confirm(t('dbviews.redisEditDelConfirm', { key: edit.key }))) return
    setBusy(true)
    try {
      await redisEdit(connId, edit, isDel)
      setDone(true)
    } catch (e) {
      setEditErr(dbErrMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // 各操作需要哪些附加输入。
  const needsValue = op === 'setString' || op === 'hashSet' || op === 'listPush' || op === 'listSet'
  const needsField = op === 'hashSet' || op === 'hashDel'
  const needsMember = op === 'setAdd' || op === 'setRem' || op === 'zadd' || op === 'zrem'
  const needsScore = op === 'zadd'
  const needsIndex = op === 'listSet'
  const needsTtl = op === 'setTtl'

  const inputStyle: React.CSSProperties = {
    flex: '1 1 120px', minWidth: 0, fontSize: 12, padding: '5px 8px',
    borderRadius: 6, border: '1px solid var(--border-subtle)',
    background: 'var(--surface-sunken)', color: 'var(--text-primary)',
  }

  return (
    <RedisKeyspaceLayout
      info={info} sampledNote={sampledNote} maxCount={maxCount} t={t}
    >
      {/* 键编辑器:保留上方只读摘要作为查看态,这里叠加增删改 + TTL 编辑 */}
      <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{t('dbviews.redisEditTitle')}</span>
        <div className="row gap8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            placeholder={t('dbviews.redisEditKey')}
            aria-label={t('dbviews.redisEditKey')}
            value={key}
            onChange={e => setKey(e.target.value)}
            style={inputStyle}
          />
          <select
            aria-label={t('dbviews.redisEditOperation')}
            value={op}
            onChange={e => setOp(e.target.value as EditOp)}
            style={{ ...inputStyle, flex: '0 1 180px' }}
          >
            {EDIT_OPS.map(o => <option key={o} value={o}>{t(`dbviews.${OP_LABEL[o]}`)}</option>)}
          </select>
        </div>
        <div className="row gap8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {needsField && (
            <input placeholder={t('dbviews.redisEditField')} aria-label={t('dbviews.redisEditField')}
              value={field} onChange={e => setField(e.target.value)} style={inputStyle} />
          )}
          {needsMember && (
            <input placeholder={t('dbviews.redisEditMember')} aria-label={t('dbviews.redisEditMember')}
              value={member} onChange={e => setMember(e.target.value)} style={inputStyle} />
          )}
          {needsIndex && (
            <input placeholder={t('dbviews.redisEditIndex')} aria-label={t('dbviews.redisEditIndex')}
              type="number" value={index} onChange={e => setIndex(e.target.value)} style={inputStyle} />
          )}
          {needsScore && (
            <input placeholder={t('dbviews.redisEditScore')} aria-label={t('dbviews.redisEditScore')}
              type="number" value={score} onChange={e => setScore(e.target.value)} style={inputStyle} />
          )}
          {needsValue && (
            <input placeholder={t('dbviews.redisEditValue')} aria-label={t('dbviews.redisEditValue')}
              value={value} onChange={e => setValue(e.target.value)} style={inputStyle} />
          )}
          {needsTtl && (
            <input placeholder={t('dbviews.redisEditTtl')} aria-label={t('dbviews.redisEditTtl')}
              type="number" value={ttl} onChange={e => setTtl(e.target.value)} style={inputStyle} />
          )}
          <button
            onClick={apply}
            disabled={busy}
            style={{
              flex: '0 0 auto', fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
              border: '1px solid var(--accent-primary)', background: 'var(--accent-primary)',
              color: 'var(--accent-on)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >{t('dbviews.redisEditApply')}</button>
        </div>
        {editErr && <span style={{ fontSize: 11.5, color: 'var(--signal-rose)' }}>{editErr}</span>}
        {done && <span style={{ fontSize: 11.5, color: 'var(--signal-green)' }}>{t('dbviews.redisEditDone')}</span>}
      </div>
    </RedisKeyspaceLayout>
  )
}

// 摘要展示布局(只读查看态)。把原有 JSX 抽到这里,编辑器作为 children 叠加在下方。
function RedisKeyspaceLayout({
  info, sampledNote, maxCount, t, children,
}: {
  info: KeyspaceInfo; sampledNote: boolean; maxCount: number
  t: (k: string, o?: Record<string, unknown>) => string; children: React.ReactNode
}) {
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
        <div className="col" style={{ alignItems: 'center', justifyContent: 'center', gap: 8, padding: '24px 0', color: 'var(--text-faint)' }}>
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

      {children}
    </div>
  )
}
