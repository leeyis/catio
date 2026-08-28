import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented } from '../atoms'
import { PanelShell } from './PanelShell'
import { AutoModal } from './AutoModal'
import {
  automationAddMcp,
  automationDeleteMcp,
  automationListMcps,
  automationTestMcp,
  type McpAuth,
  type McpConnection,
} from '../../services/automation'

const statusChip = (s: McpConnection['status']) =>
  s === 'connected'
    ? <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 14%, transparent)', color: 'var(--signal-green)' }}>已连接</span>
    : s === 'error'
      ? <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-rose) 14%, transparent)', color: 'var(--signal-rose)' }}>连接失败</span>
      : <span className="chip">未连接</span>

export function McpPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [mcps, setMcps] = useState<McpConnection[]>([])
  const [showNew, setShowNew] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)

  const refresh = () => void automationListMcps().then(setMcps)
  useEffect(() => { refresh() }, [])

  const remove = (m: McpConnection) => {
    if (!window.confirm(`删除 MCP「${m.name}」？`)) return
    void automationDeleteMcp(m.id).then(refresh)
  }

  const retest = async (m: McpConnection) => {
    setTestingId(m.id)
    try {
      const tools = await automationTestMcp(m)
      // Refresh the in-memory list so the chip/工具数 update for this save session.
      setMcps(prev => prev.map(x => x.id === m.id ? { ...x, status: 'connected', discoveredTools: tools } : x))
    } catch {
      setMcps(prev => prev.map(x => x.id === m.id ? { ...x, status: 'error' } : x))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <PanelShell icon="m" title={t('panels.mcpTitle')} sub={t('panels.mcpSub')} onClose={onClose}
      actions={<Btn size="sm" variant="primary" icon="plus" onClick={() => setShowNew(true)}>{t('panels.mcpAdd')}</Btn>}>
      <div className="col grow" style={{ minHeight: 0, overflowY: 'auto', padding: 10, gap: 6 }}>
        <div key="__builtin__" className="row gap10"
          style={{ padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--accent-primary) 5%, var(--surface-card))', border: '1px solid var(--accent-border)' }}>
          <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
            <Icon name="alarm-clock" size={16} />
          </div>
          <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
            <div className="row gap6" style={{ minWidth: 0, flexWrap: 'wrap' }}>
              <span className="ell" style={{ fontSize: 13, fontWeight: 600 }}>{t('panels.builtinTasks')}</span>
              <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-green) 14%, transparent)', color: 'var(--signal-green)' }}>内置</span>
              <span className="chip">MCP</span>
            </div>
            <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>catio://builtin/tasks</span>
            <div className="row gap6" style={{ flexWrap: 'wrap' }}>
              <span className="chip">6 工具</span>
              <span className="chip">{t('panels.builtinTasksSub')}</span>
            </div>
          </div>
        </div>
        {mcps.length === 0 && (
          <div className="col" style={{ alignItems: 'center', padding: '30px 0', gap: 8, color: 'var(--text-faint)' }}>
            <Icon name="m" size={22} /><span style={{ fontSize: 12.5 }}>{t('panels.mcpAdd')}</span>
          </div>
        )}
        {mcps.map(m => (
          <div key={m.id} className="row gap10" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)' }}>
            <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="m" size={16} /></div>
            <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
              <div className="row gap6" style={{ minWidth: 0, flexWrap: 'wrap' }}>
                <span className="ell" style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</span>
                {statusChip(m.status)}
                <span className="chip">Streamable HTTP</span>
              </div>
              <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{m.url}</span>
              <div className="row gap6" style={{ flexWrap: 'wrap' }}>
                <span className="chip">{m.discoveredTools.length} 工具</span>
                <span className="chip">{m.auth === 'none' ? '无认证' : m.auth === 'bearer' ? 'Bearer token' : 'Header 认证'}</span>
              </div>
            </div>
            <button className="icon-btn bare" title="测试连接 / 刷新工具"
              onClick={() => void retest(m)}
              disabled={testingId === m.id}
              style={{ width: 28, height: 28, display: 'grid', placeItems: 'center' }}>
              <span style={{ animation: testingId === m.id ? 'spin .8s linear infinite' : 'none' }}>
                <Icon name="refresh-cw" size={14} />
              </span>
            </button>
            <IconBtn name="trash-2" size={14} variant="bare" onClick={() => remove(m)} />
          </div>
        ))}
      </div>

      {showNew && <McpFormModal onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); refresh() }} />}
    </PanelShell>
  )
}

function McpFormModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<McpAuth>('none')
  const [credential, setCredential] = useState('')
  const [tools, setTools] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)

  const conn = (): Omit<McpConnection, 'ownerId'> => ({
    id: `mcp-${Date.now()}`, name, transport: 'http', url, auth, credential,
    toolAllowlist: [], status: tools ? 'connected' : 'disconnected', discoveredTools: tools ?? [],
  })

  const test = async () => {
    setTesting(true); setError('')
    try { setTools(await automationTestMcp({ ...conn(), ownerId: 'local' })) }
    catch (e) { setError(String(e)); setTools(null) }
    finally { setTesting(false) }
  }

  const save = async () => {
    try { await automationAddMcp(conn()); onDone() }
    catch (e) { setError(String(e)) }
  }

  const input = { width: '100%', height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, outline: 'none' } as const
  const label = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' } as const

  return (
    <AutoModal title={t('panels.mcpAdd')} onClose={onClose}
      footer={<>
        <Btn variant="secondary" onClick={onClose}>{t('panels.cancel')}</Btn>
        <Btn variant="primary" onClick={save}>保存</Btn>
      </>}>
      <div className="col gap4">
        <span style={label}>名称</span>
        <input style={input} value={name} onChange={e => setName(e.target.value)} placeholder="GitHub" />
      </div>
      <div className="col gap4">
        <span style={label}>传输</span>
        <Segmented size="sm" value="http" onChange={() => {}}
          options={[{ value: 'http', label: 'Streamable HTTP' }, { value: 'stdio', label: 'stdio（待支持）' }]} />
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>当前仅支持 Streamable HTTP</span>
      </div>
      <div className="col gap4">
        <span style={label}>Endpoint URL</span>
        <input style={input} className="mono" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:8080/mcp" />
      </div>
      <div className="col gap4">
        <span style={label}>认证</span>
        <Segmented size="sm" value={auth} onChange={v => setAuth(v as McpAuth)}
          options={[{ value: 'none', label: '无' }, { value: 'bearer', label: 'Bearer' }, { value: 'header', label: 'Header' }]} />
        {auth !== 'none' && (
          <input style={input} className="mono" value={credential} onChange={e => setCredential(e.target.value)} placeholder="sk-…（仅本会话内存，不落盘）" />
        )}
      </div>
      <Btn size="sm" variant="secondary" onClick={test} disabled={testing}>{testing ? '测试中…' : t('panels.mcpTest')}</Btn>
      {tools && (
        <div className="col gap4">
          <span style={label}>发现 {tools.length} 个工具</span>
          <div className="col" style={{ gap: 3 }}>
            {tools.map(tool => <span key={tool} className="mono" style={{ fontSize: 11, background: 'var(--surface-sunken)', padding: '3px 8px', borderRadius: 6 }}>{tool}</span>)}
          </div>
        </div>
      )}
      {error && <span style={{ fontSize: 11, color: 'var(--danger-fg)' }}>{error}</span>}
    </AutoModal>
  )
}
