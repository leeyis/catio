import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented } from '../atoms'
import { PanelShell } from './PanelShell'
import { AutoModal } from './AutoModal'
import {
  automationDeleteSkill,
  automationImportSkill,
  automationInstallSkill,
  automationListSkills,
  automationSetSkillEnabled,
  type Skill,
  type SkillScope,
} from '../../services/automation'

const scopeChip = (s: Skill) =>
  s.scope === 'global'
    ? <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-blue) 14%, transparent)', color: 'var(--signal-blue)' }}>全局</span>
    : <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-violet) 14%, transparent)', color: 'var(--signal-violet)' }}>目标专属</span>

const riskChip = (risk: Skill['riskPolicy']) => {
  const map: Record<Skill['riskPolicy'], [string, string]> = {
    readonly: ['只读', 'var(--signal-green)'],
    readonlyPreferred: ['只读优先', 'var(--text-tertiary)'],
    confirmedWrite: ['确认写入', 'var(--signal-amber)'],
  }
  const [label, color] = map[risk]
  return <span className="chip" style={{ background: 'color-mix(in srgb, var(--signal-amber) 14%, transparent)', color }}>{label}</span>
}

export function SkillsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<Skill[]>([])
  const [mode, setMode] = useState<'import' | 'install' | null>(null)

  const refresh = () => void automationListSkills().then(setSkills)
  useEffect(() => { refresh() }, [])

  const toggle = (s: Skill, enabled: boolean) => void automationSetSkillEnabled(s.id, enabled).then(refresh)
  const remove = (s: Skill) => {
    if (!window.confirm(`删除技能「${s.name}」？`)) return
    void automationDeleteSkill(s.id).then(refresh)
  }

  return (
    <PanelShell icon="zap" title={t('panels.skillsTitle')} sub={t('panels.skillsSub')} onClose={onClose}>
      <div className="row gap8" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
        <Btn size="sm" variant="primary" style={{ flex: 1 }} onClick={() => setMode('import')}>{t('panels.skillImport')}</Btn>
        <Btn size="sm" variant="secondary" style={{ flex: 1 }} onClick={() => setMode('install')}>{t('panels.skillInstall')}</Btn>
      </div>
      <div className="col grow" style={{ minHeight: 0, overflowY: 'auto', padding: 10, gap: 6 }}>
        {skills.length === 0 && (
          <div className="col" style={{ alignItems: 'center', padding: '30px 0', gap: 8, color: 'var(--text-faint)' }}>
            <Icon name="zap" size={22} /><span style={{ fontSize: 12.5 }}>{t('panels.skillImport')} / {t('panels.skillInstall')}</span>
          </div>
        )}
        {skills.map(s => (
          <div key={s.id} className="row gap10" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', opacity: s.enabled ? 1 : 0.55 }}>
            <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}><Icon name="zap" size={16} /></div>
            <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
              <div className="row gap6" style={{ minWidth: 0 }}>
                <span className="ell" style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                <span className="chip mono">v{s.version}</span>
                {scopeChip(s)}
                {s.source.type === 'url'
                  ? <span className="chip violet">在线安装</span>
                  : <span className="chip">导入</span>}
              </div>
              <span className="ell" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{s.promptTemplate}</span>
              <div className="row gap6" style={{ marginTop: 2 }}>{riskChip(s.riskPolicy)}</div>
            </div>
            <button className={`toggle ${s.enabled ? 'on' : ''}`} aria-pressed={s.enabled} onClick={() => toggle(s, !s.enabled)}><span className="knob" /></button>
            <IconBtn name="trash-2" size={14} variant="bare" onClick={() => remove(s)} />
          </div>
        ))}
      </div>

      {mode && <SkillFormModal mode={mode} onClose={() => setMode(null)} onDone={() => { setMode(null); refresh() }} />}
    </PanelShell>
  )
}

function SkillFormModal({ mode, onClose, onDone }: { mode: 'import' | 'install'; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<SkillScope>('global')
  const [targetRef, setTargetRef] = useState('')
  const [body, setBody] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const save = async () => {
    try {
      if (mode === 'import') await automationImportSkill(body, scope, targetRef || undefined)
      else await automationInstallSkill(url, scope, targetRef || undefined)
      onDone()
    } catch (e) {
      setError(String(e))
    }
  }

  const input = { width: '100%', height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, outline: 'none' } as const
  const label = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' } as const

  return (
    <AutoModal title={mode === 'import' ? t('panels.skillImport') : t('panels.skillInstall')} onClose={onClose}
      footer={<>
        <Btn variant="secondary" onClick={onClose}>{t('panels.cancel')}</Btn>
        <Btn variant="primary" onClick={save}>{mode === 'import' ? t('panels.skillImport') : t('panels.skillInstall')}</Btn>
      </>}>
      <div className="col gap4">
        <span style={label}>{t('panels.skillScope')}</span>
        <Segmented size="sm" value={scope} onChange={v => setScope(v as SkillScope)}
          options={[{ value: 'global', label: '全局' }, { value: 'target', label: '指定连接' }]} />
        {scope === 'target' && <input style={input} value={targetRef} onChange={e => setTargetRef(e.target.value)} placeholder="web-01 / postgres-prod" />}
      </div>
      {mode === 'import' ? (
        <div className="col gap4">
          <span style={label}>技能 JSON</span>
          <textarea rows={5} style={{ ...input, height: 110, paddingTop: 8 }} className="mono" value={body} onChange={e => setBody(e.target.value)} placeholder='{ "name": "巡检", "promptTemplate": "检查 {{host}}" }' />
        </div>
      ) : (
        <div className="col gap4">
          <span style={label}>技能 URL</span>
          <input style={input} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/skill.json" />
        </div>
      )}
      {error && <span style={{ fontSize: 11, color: 'var(--danger-fg)' }}>{error}</span>}
    </AutoModal>
  )
}
