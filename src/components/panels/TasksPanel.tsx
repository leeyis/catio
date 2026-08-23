import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { Btn, IconBtn, Segmented } from '../atoms'
import { PanelShell } from './PanelShell'
import { AutoModal } from './AutoModal'
import {
  automationCreateTask,
  automationDeleteTask,
  automationListTasks,
  automationSetTaskEnabled,
  type ScheduledTask,
  type TaskKind,
  type TaskPolicy,
  type TaskTrigger,
} from '../../services/automation'

function triggerLabel(t: TaskTrigger): string {
  if (t.type === 'cron') return t.expr
  if (t.type === 'interval') return `每 ${t.seconds}s`
  return t.at
}

export function TasksPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [showNew, setShowNew] = useState(false)

  const refresh = () => void automationListTasks().then(setTasks)
  useEffect(() => { refresh() }, [])

  const toggleEnabled = (task: ScheduledTask, enabled: boolean) =>
    void automationSetTaskEnabled(task.id, enabled).then(refresh)
  const remove = (task: ScheduledTask) => {
    if (!window.confirm(`删除任务「${task.name}」？`)) return
    void automationDeleteTask(task.id).then(refresh)
  }

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
        {tasks.map(task => (
          <div key={task.id} className="row gap10"
            style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', opacity: task.enabled ? 1 : 0.55 }}>
            <div className="icon-badge" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent-primary)' }}>
              <Icon name="alarm-clock" size={16} />
            </div>
            <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
              <div className="row gap6" style={{ minWidth: 0 }}>
                <span className="ell" style={{ fontSize: 13, fontWeight: 600 }}>{task.name}</span>
                <span className="chip">{task.kind}</span>
                <span className="chip mono">{triggerLabel(task.trigger)}</span>
              </div>
              <span className="ell mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                {task.targetRef || '—'}{task.policy !== 'reject' ? ` · ${task.policy}` : ''}
              </span>
            </div>
            <button className={`toggle ${task.enabled ? 'on' : ''}`} aria-pressed={task.enabled}
              onClick={() => toggleEnabled(task, !task.enabled)}><span className="knob" /></button>
            <IconBtn name="trash-2" size={14} variant="bare" onClick={() => remove(task)} />
          </div>
        ))}
      </div>

      {showNew && (
        <AutoModal title={t('panels.tasksNew')} onClose={() => setShowNew(false)}
          footer={<Btn variant="secondary" onClick={() => setShowNew(false)}>{t('panels.cancel')}</Btn>}>
          <TaskForm onDone={() => { setShowNew(false); refresh() }} />
        </AutoModal>
      )}
    </PanelShell>
  )
}

interface Draft {
  name: string
  triggerType: 'cron' | 'interval' | 'once'
  cron: string
  seconds: string
  onceAt: string
  kind: TaskKind
  script: string
  prompt: string
  targetRef: string
  policy: TaskPolicy
  whitelist: string
}

const emptyDraft: Draft = {
  name: '', triggerType: 'cron', cron: '0 2 * * *', seconds: '3600', onceAt: '', kind: 'shell',
  script: '', prompt: '', targetRef: '', policy: 'reject', whitelist: '',
}

function TaskForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [d, setD] = useState<Draft>(emptyDraft)
  const set = (patch: Partial<Draft>) => setD(p => ({ ...p, ...patch }))

  const trigger: TaskTrigger =
    d.triggerType === 'cron' ? { type: 'cron', expr: d.cron }
    : d.triggerType === 'interval' ? { type: 'interval', seconds: Number(d.seconds) || 3600 }
    : { type: 'once', at: d.onceAt }

  const save = async () => {
    if (!d.name.trim()) return
    try {
      await automationCreateTask({
        id: `task-${Date.now()}`, name: d.name.trim(), trigger, kind: d.kind,
        script: d.kind === 'shell' ? d.script : undefined,
        prompt: d.kind === 'prompt' ? d.prompt : undefined,
        targetRef: d.targetRef || undefined,
        skillIds: [], mcpIds: [], policy: d.policy,
        whitelist: d.whitelist.split('\n').map(s => s.trim()).filter(Boolean),
        enabled: true, autoConfirmed: d.policy === 'auto',
      })
      onDone()
    } catch (e) { console.error(e) }
  }

  const input = { width: '100%', height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-hairline)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontSize: 12.5, outline: 'none' } as const
  const label = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' } as const

  return (
    <>
      <div className="col gap4">
        <span style={label}>{t('panels.tasksTitle')} · 名称</span>
        <input style={input} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="每日数据库备份巡检" />
      </div>
      <div className="col gap4">
        <span style={label}>触发器</span>
        <Segmented size="sm" value={d.triggerType} onChange={v => set({ triggerType: v as Draft['triggerType'] })}
          options={[{ value: 'cron', label: 'cron' }, { value: 'interval', label: '间隔' }, { value: 'once', label: '一次性' }]} />
        {d.triggerType === 'cron' && <input style={input} className="mono" value={d.cron} onChange={e => set({ cron: e.target.value })} />}
        {d.triggerType === 'interval' && <input style={input} className="mono" value={d.seconds} onChange={e => set({ seconds: e.target.value })} placeholder="秒" />}
        {d.triggerType === 'once' && <input style={input} value={d.onceAt} onChange={e => set({ onceAt: e.target.value })} placeholder="2026-08-23T22:30:00Z" />}
      </div>
      <div className="col gap4">
        <span style={label}>执行体</span>
        <Segmented size="sm" value={d.kind} onChange={v => set({ kind: v as TaskKind })}
          options={[{ value: 'shell', label: 'shell' }, { value: 'prompt', label: 'prompt' }]} />
        {d.kind === 'shell'
          ? <textarea rows={3} style={{ ...input, height: 80, paddingTop: 8, fontFamily: 'var(--font-mono, monospace)' }} value={d.script} onChange={e => set({ script: e.target.value })} placeholder="pg_dump -Fc prod > /backup/prod.dump" />
          : <textarea rows={3} style={{ ...input, height: 80, paddingTop: 8 }} value={d.prompt} onChange={e => set({ prompt: e.target.value })} placeholder="检查磁盘空间，超过 80% 时汇总最大文件" />}
      </div>
      <div className="col gap4">
        <span style={label}>目标主机 / 数据库</span>
        <input style={input} value={d.targetRef} onChange={e => set({ targetRef: e.target.value })} placeholder="web-01 · * = 全部" />
      </div>
      <div className="col gap4">
        <span style={label}>无人值守权限策略</span>
        <Segmented size="sm" value={d.policy} onChange={v => set({ policy: v as TaskPolicy })}
          options={[{ value: 'reject', label: '拒绝敏感' }, { value: 'whitelist', label: '白名单' }, { value: 'auto', label: '自动放行' }]} />
        {d.policy === 'auto' && (
          <span style={{ fontSize: 11, color: 'var(--danger-fg)', background: 'var(--danger-soft)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--danger-border)' }}>
            自动放行意味着敏感命令直接执行，可能造成不可逆操作。仅对完全可信目标开启。
          </span>
        )}
        {d.policy === 'whitelist' && (
          <textarea rows={2} style={{ ...input, height: 56, paddingTop: 8 }} className="mono" value={d.whitelist} onChange={e => set({ whitelist: e.target.value })} placeholder="每行一条白名单命令" />
        )}
      </div>
      <Btn variant="primary" style={{ alignSelf: 'flex-end' }} onClick={save}>保存任务</Btn>
    </>
  )
}
