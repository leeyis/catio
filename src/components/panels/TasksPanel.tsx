import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented } from '../atoms'
import { PanelShell } from './PanelShell'
import { AutoModal, SearchSelect, type TargetOption } from './AutoModal'
import { isTauri } from '../../services/ssh'
import {
  automationCreateTask,
  automationDeleteTask,
  automationListMcps,
  automationListSkills,
  automationListTasks,
  automationSetTaskEnabled,
  automationTaskResults,
  type McpConnection,
  type ScheduledTask,
  type Skill,
  type TaskKind,
  type TaskPolicy,
  type TaskRunInfo,
  type TaskTrigger,
} from '../../services/automation'

// ── helpers ─────────────────────────────────────────────────────────────────

const triggerChip = (t: TaskTrigger): [string, string] => {
  if (t.type === 'cron') return ['blue', 'cron']
  if (t.type === 'interval') return ['violet', 'interval']
  return ['amber', 'once']
}

const kindChip = (k: TaskKind): [string, string] =>
  k === 'shell' ? ['', 'shell'] : ['green', 'prompt']

function fmtClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function intervalLabel(seconds: number): string {
  return seconds % 60 === 0 ? `每 ${seconds / 60} 分钟` : `每 ${seconds} 秒`
}

function triggerExpr(t: TaskTrigger): string {
  if (t.type === 'cron') return t.expr
  if (t.type === 'interval') return intervalLabel(t.seconds)
  return fmtClock(t.at)
}

function nextLabel(t: TaskTrigger): string {
  if (t.type === 'cron') {
    const [mm, hh] = t.expr.split(/\s+/)
    return `每天 ${String(hh || '').padStart(2, '0')}:${String(mm || '').padStart(2, '0')}`
  }
  if (t.type === 'interval') return intervalLabel(t.seconds)
  return fmtClock(t.at)
}

// ── panel ───────────────────────────────────────────────────────────────────

export function TasksPanel({ onClose, targets }: { onClose: () => void; targets: TargetOption[] }) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcps, setMcps] = useState<McpConnection[]>([])
  const [results, setResults] = useState<Record<string, TaskRunInfo>>({})
  const [showNew, setShowNew] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)

  const refresh = () => void automationListTasks().then(setTasks)
  useEffect(() => { refresh() }, [])
  useEffect(() => { void automationListSkills().then(setSkills) }, [])
  useEffect(() => { void automationListMcps().then(setMcps) }, [])
  const refreshResults = () => void automationTaskResults().then(list =>
    setResults(Object.fromEntries(list.map(r => [r.taskId, r]))))
  useEffect(() => {
    let alive = true
    const poll = () => void automationTaskResults().then(list => { if (alive) setResults(Object.fromEntries(list.map(r => [r.taskId, r]))) })
    poll()
    const id = window.setInterval(poll, 3000)
    return () => { alive = false; window.clearInterval(id) }
  }, [])
  // Live-run events from the backend refresh results immediately (no 3s wait).
  useEffect(() => {
    if (!isTauri()) return
    let un: (() => void) | undefined
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      un = await listen('automation://task-run', refreshResults)
    })
    return () => { un?.() }
  }, [])

  const toggleEnabled = (task: ScheduledTask, enabled: boolean) =>
    void automationSetTaskEnabled(task.id, enabled).then(refresh)
  const remove = (task: ScheduledTask) => {
    if (!window.confirm(`删除任务「${task.name}」？`)) return
    void automationDeleteTask(task.id).then(refresh)
  }

  const nameOf = (ids: string[], list: { id: string; name: string }[]) =>
    ids.map(id => list.find(x => x.id === id)?.name ?? id)

  return (
    <PanelShell icon="alarm-clock" title={t('panels.tasksTitle')} sub={t('panels.tasksSub')} onClose={onClose}
      actions={<Btn size="sm" variant="primary" icon="plus" onClick={() => setShowNew(true)}>{t('panels.tasksNew')}</Btn>}>
      <div className="col grow" style={{ minHeight: 0, overflowY: 'auto', padding: 10, gap: 6 }}>
        <span className="chip" style={{ alignSelf: 'flex-start', margin: '0 2px 4px' }}>
          {t('panels.tasksRunning', { count: tasks.filter(x => x.enabled).length })}
        </span>
        {tasks.length === 0 && (
          <div className="col" style={{ alignItems: 'center', padding: '30px 0', gap: 8, color: 'var(--text-faint)' }}>
            <Icon name="alarm-clock" size={22} /><span style={{ fontSize: 12.5 }}>{t('panels.tasksNew')}</span>
          </div>
        )}
        {tasks.map(task => {
          const [tc, tl] = triggerChip(task.trigger)
          const [kc, kl] = kindChip(task.kind)
          const skillNames = nameOf(task.skillIds, skills)
          const mcpNames = nameOf(task.mcpIds, mcps)
          const run = results[task.id]
          return (
            <div key={task.id} className="row gap10"
              style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', opacity: task.enabled ? 1 : 0.55 }}>
              <div className="icon-badge" style={{ width: 38, height: 38, borderRadius: 10, background: run && run.status === 'failed' ? 'var(--danger-soft)' : 'var(--accent-soft)', color: run && run.status === 'failed' ? 'var(--danger-fg)' : 'var(--accent-primary)' }}>
                <Icon name="alarm-clock" size={17} />
              </div>
              <div className="col grow" style={{ minWidth: 0, gap: 3 }}>
                <div className="row gap6" style={{ minWidth: 0, flexWrap: 'wrap' }}>
                  <span className="ell" style={{ fontSize: 13, fontWeight: 600 }}>{task.name}</span>
                  <span className={`chip${kc ? ` ${kc}` : ''}`}>{kl}</span>
                  <span className={`chip ${tc} mono`}>{tl}</span>
                </div>
                <div className="row gap6" style={{ minWidth: 0, flexWrap: 'wrap' }}>
                  <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }} title={`${triggerExpr(task.trigger)} · 目标 ${task.targetRef ?? '—'}`}>
                    {triggerExpr(task.trigger)} · 目标 {task.targetRef || '—'}
                  </span>
                  {skillNames.length > 0 && <span className="chip violet">{skillNames.join(' / ')}</span>}
                  {mcpNames.length > 0 && <span className="chip">{`MCP ${mcpNames.join(' / ')}`}</span>}
                </div>
                <div className="row gap6" style={{ flexWrap: 'wrap', marginTop: 2 }}>
                  <span className="chip">下次 {nextLabel(task.trigger)}</span>
                  {(() => {
                    const runOk = run?.status === 'success'
                    const runColor = runOk ? 'var(--signal-green)' : 'var(--signal-rose)'
                    return (
                      <span className="chip" style={run ? { background: `color-mix(in srgb, ${runColor} 14%, transparent)`, color: runColor } : undefined}>
                        上次 {run ? `${runOk ? '成功' : '失败'}: ${run.summary}` : '从未运行'}
                      </span>
                    )
                  })()}
                </div>
              </div>
              <button className={`toggle ${task.enabled ? 'on' : ''}`} aria-pressed={task.enabled}
                onClick={() => toggleEnabled(task, !task.enabled)}><span className="knob" /></button>
              <IconBtn name="pencil" size={14} variant="bare" title="编辑任务" onClick={() => setEditing(task)} />
              <IconBtn name="trash-2" size={14} variant="bare" onClick={() => remove(task)} />
            </div>
          )
        })}
      </div>

      {showNew && (
        <AutoModal title={t('panels.tasksNew')} onClose={() => setShowNew(false)}
          footer={<Btn variant="secondary" onClick={() => setShowNew(false)}>{t('panels.cancel')}</Btn>}>
          <TaskForm skills={skills} mcps={mcps} targets={targets} onDone={() => { setShowNew(false); refresh() }} />
        </AutoModal>
      )}
      {editing && (
        <AutoModal title={t('panels.tasksEdit')} onClose={() => setEditing(null)}
          footer={<Btn variant="secondary" onClick={() => setEditing(null)}>{t('panels.cancel')}</Btn>}>
          <TaskForm initial={editing} skills={skills} mcps={mcps} targets={targets} onDone={() => { setEditing(null); refresh() }} />
        </AutoModal>
      )}
    </PanelShell>
  )
}

// ── new-task form (aligns with the prototype modal) ─────────────────────────

interface Draft {
  name: string
  triggerType: 'cron' | 'interval' | 'once'
  cron: string
  intervalMinutes: string
  intervalUnit: 'm' | 'h'
  onceAt: string
  kind: TaskKind
  script: string
  prompt: string
  targetRef: string
  policy: TaskPolicy
  whitelist: string
  skillIds: string[]
  mcpIds: string[]
}

const emptyDraft: Draft = {
  name: '', triggerType: 'cron', cron: '0 2 * * *', intervalMinutes: '30', intervalUnit: 'm', onceAt: '', kind: 'shell',
  script: '', prompt: '', targetRef: '', policy: 'reject', whitelist: '',
  skillIds: [], mcpIds: [],
}

const input = { width: '100%', height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, outline: 'none' } as const
const label = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' } as const

/** Friendly cron picker: common presets + a raw 5-field editor. */
function CronField({ value, onChange }: { value: string; onChange: (expr: string) => void }) {
  const presets: [string, string][] = [
    ['* * * * *', '每分钟'],
    ['0 * * * *', '每小时'],
    ['0 0 * * *', '每天'],
    ['0 0 * * 1', '每周一'],
    ['0 0 1 * *', '每月'],
  ]
  const [custom, setCustom] = useState(presets.some(([e]) => e === value) ? '' : value)
  const active = (expr: string) => value === expr
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row gap4" style={{ flexWrap: 'wrap' }}>
        {presets.map(([expr, name]) => (
          <button key={expr} type="button" onClick={() => { setCustom(''); onChange(expr) }}
            style={{ height: 26, padding: '0 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
              background: active(expr) ? 'var(--accent-soft)' : 'var(--surface-sunken)',
              color: active(expr) ? 'var(--accent-primary)' : 'var(--text-tertiary)',
              border: active(expr) ? '1px solid var(--accent-border)' : '1px solid transparent' }}>
            {name}
          </button>
        ))}
      </div>
      <div className="col" style={{ gap: 3 }}>
        <input className="mono" style={{ ...input, height: 32 }} value={custom} onChange={e => { setCustom(e.target.value); onChange(e.target.value) }} placeholder="自定义：分 时 日 月 周" />
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{value}</span>
      </div>
    </div>
  )
}

function MultiSelect({ labelText, options, value, onChange }: {
  labelText: string
  options: { id: string; name: string; sub?: string }[]
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id])
  return (
    <div className="col gap4">
      <span style={label}>{labelText}</span>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ ...input, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', height: 34 }}>
        <span style={{ color: value.length ? 'var(--text-primary)' : 'var(--text-faint)', fontSize: 12.5 }}>
          {value.length ? `已选 ${value.length} 项` : '选择…'}
        </span>
        <Icon name="chevron-down" size={13} style={{ color: 'var(--text-faint)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && (
        <div className="col" style={{ gap: 2, border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 4, background: 'var(--surface-card)' }}>
          {options.map(o => (
            <label key={o.id} className="row gap8" style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: value.includes(o.id) ? 'var(--accent-soft)' : 'transparent' }}>
              <input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} style={{ accentColor: 'var(--accent-primary)' }} />
              <span style={{ fontSize: 12.5 }}>{o.name}</span>
              {o.sub && <span className="chip">{o.sub}</span>}
            </label>
          ))}
          {options.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-faint)', padding: 6 }}>暂无可用项</span>}
        </div>
      )}
      {value.length > 0 && (
        <div className="row gap4" style={{ flexWrap: 'wrap' }}>
          {value.map(id => {
            const o = options.find(x => x.id === id)
            return <span key={id} className="chip">{o?.name ?? id}</span>
          })}
        </div>
      )}
    </div>
  )
}

function fromTask(t: ScheduledTask): Draft {
  return {
    name: t.name,
    triggerType: t.trigger.type,
    cron: t.trigger.type === 'cron' ? t.trigger.expr : '0 2 * * *',
    intervalMinutes: t.trigger.type === 'interval' ? String(t.trigger.seconds % 3600 === 0 ? t.trigger.seconds / 3600 : t.trigger.seconds / 60) : '30',
    intervalUnit: t.trigger.type === 'interval' && t.trigger.seconds % 3600 === 0 ? 'h' : 'm',
    onceAt: t.trigger.type === 'once' ? t.trigger.at : '',
    kind: t.kind,
    script: t.script ?? '',
    prompt: t.prompt ?? '',
    targetRef: t.targetRef ?? '',
    policy: t.policy,
    whitelist: t.whitelist.join('\n'),
    skillIds: t.skillIds,
    mcpIds: t.mcpIds,
  }
}

function TaskForm({ skills, mcps, targets, onDone, initial }: { skills: Skill[]; mcps: McpConnection[]; targets: TargetOption[]; onDone: () => void; initial?: ScheduledTask }) {
  const [d, setD] = useState<Draft>(() => initial ? fromTask(initial) : emptyDraft)
  const set = (patch: Partial<Draft>) => setD(p => ({ ...p, ...patch }))

  const trigger: TaskTrigger =
    d.triggerType === 'cron' ? { type: 'cron', expr: d.cron }
      : d.triggerType === 'interval' ? { type: 'interval', seconds: (Number(d.intervalMinutes) || 30) * (d.intervalUnit === 'h' ? 3600 : 60) }
        : { type: 'once', at: d.onceAt }

  const save = async () => {
    if (!d.name.trim()) return
    try {
      await automationCreateTask({
        id: initial?.id ?? `task-${Date.now()}`, name: d.name.trim(), trigger, kind: d.kind,
        script: d.kind === 'shell' ? d.script : undefined,
        prompt: d.kind === 'prompt' ? d.prompt : undefined,
        targetRef: d.targetRef || undefined,
        skillIds: d.skillIds, mcpIds: d.mcpIds, policy: d.policy,
        whitelist: d.whitelist.split('\n').map(s => s.trim()).filter(Boolean),
        enabled: true, autoConfirmed: d.policy === 'auto',
      })
      onDone()
    } catch (e) { console.error(e) }
  }

  return (
    <>
      <div className="col gap4">
        <span style={label}>任务名称</span>
        <input style={input} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="例如：每日数据库备份巡检" />
      </div>
      <div className="col gap4">
        <span style={label}>触发器类型</span>
        <Segmented size="sm" value={d.triggerType} onChange={v => set({ triggerType: v as Draft['triggerType'] })}
          options={[{ value: 'cron', label: 'cron' }, { value: 'interval', label: '间隔' }, { value: 'once', label: '一次性' }]} />
        {d.triggerType === 'cron' && <CronField value={d.cron} onChange={v => set({ cron: v })} />}
        {d.triggerType === 'interval' && (
          <div className="row gap6" style={{ alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>每</span>
            <input className="mono" style={{ ...input, width: 70, height: 30 }} value={d.intervalMinutes} onChange={e => set({ intervalMinutes: e.target.value })} />
            <Segmented size="sm" value={d.intervalUnit} onChange={v => set({ intervalUnit: v as 'm' | 'h' })}
              options={[{ value: 'm', label: '分钟' }, { value: 'h', label: '小时' }]} />
          </div>
        )}
        {d.triggerType === 'once' && (
          <input type="datetime-local" style={input} value={d.onceAt ? d.onceAt.slice(0, 16) : ''}
            onChange={e => set({ onceAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} />
        )}
      </div>
      <div className="col gap4">
        <span style={label}>执行体</span>
        <Segmented size="sm" value={d.kind} onChange={v => set({ kind: v as TaskKind })}
          options={[{ value: 'shell', label: 'shell 脚本' }, { value: 'prompt', label: 'prompt' }]} />
        {d.kind === 'shell'
          ? <textarea rows={3} style={{ ...input, height: 80, paddingTop: 8, fontFamily: 'var(--font-mono, monospace)' }} value={d.script} onChange={e => set({ script: e.target.value })} placeholder="pg_dump -Fc prod > /backup/prod.dump" />
          : <>
            <textarea rows={3} style={{ ...input, height: 80, paddingTop: 8 }} value={d.prompt} onChange={e => set({ prompt: e.target.value })} placeholder="检查磁盘空间，超过 80% 时汇总最大文件并给出清理建议" />
            <MultiSelect labelText="引用技能" options={skills.map(s => ({ id: s.id, name: s.name, sub: s.riskPolicy === 'readonly' ? '只读' : s.riskPolicy === 'readonlyPreferred' ? '只读优先' : '确认写入' }))} value={d.skillIds} onChange={ids => set({ skillIds: ids })} />
            <MultiSelect labelText="可用 MCP" options={mcps.map(m => ({ id: m.id, name: m.name, sub: `${m.discoveredTools.length} 工具` }))} value={d.mcpIds} onChange={ids => set({ mcpIds: ids })} />
          </>}
      </div>
      <div className="col gap4">
        <span style={label}>目标主机 / 数据库</span>
        <SearchSelect options={targets} value={d.targetRef} onChange={id => set({ targetRef: id })} placeholder="选择已连接的主机或数据库…" />
      </div>
      <div className="col gap4">
        <span style={label}>无人值守权限策略</span>
        {([['reject', '拒绝敏感命令（默认）', '敏感命令自动拒绝并记录，任务继续其余步骤。最安全。'],
          ['whitelist', '命令白名单', '仅放行精确匹配白名单的命令，其余敏感命令拒绝。'],
          ['auto', '自动放行敏感命令', '敏感命令不经审批直接执行。高风险。']] as [TaskPolicy, string, string][]).map(([v, title, desc]) => (
          <label key={v} className="row gap10" style={{ padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border-hairline)', cursor: 'pointer', background: d.policy === v ? 'var(--accent-soft)' : 'transparent' }}>
            <input type="radio" checked={d.policy === v} onChange={() => set({ policy: v })} style={{ accentColor: 'var(--accent-primary)' }} />
            <span className="col" style={{ gap: 1 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{desc}</span>
            </span>
          </label>
        ))}
        {d.policy === 'auto' && (
          <div className="col" style={{ gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--danger-fg)', background: 'var(--danger-soft)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--danger-border)' }}>
              自动放行意味着模型提出的敏感命令将直接执行，可能造成数据损坏或不可逆操作。仅对完全可信、隔离的目标开启。
            </span>
            <label className="row gap8" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={d.policy === 'auto'} onChange={() => {}} style={{ accentColor: 'var(--accent-primary)' }} />
              <span style={{ fontSize: 12 }}>我已理解风险，为这个任务显式开启自动放行</span>
            </label>
          </div>
        )}
        {d.policy === 'whitelist' && (
          <textarea rows={2} style={{ ...input, height: 56, paddingTop: 8 }} className="mono" value={d.whitelist} onChange={e => set({ whitelist: e.target.value })} placeholder="每行一条白名单命令" />
        )}
      </div>
      <Btn variant="primary" style={{ alignSelf: 'flex-end' }} onClick={save}>保存任务</Btn>
    </>
  )
}
