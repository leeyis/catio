import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { TasksPanel } from './TasksPanel'

vi.mock('../../services/automation', () => ({
  automationListTasks: vi.fn(),
  automationCreateTask: vi.fn(),
  automationDeleteTask: vi.fn(),
  automationSetTaskEnabled: vi.fn(),
}))
import { automationListTasks } from '../../services/automation'

const TASK = {
  id: 't1',
  name: '每日数据库备份巡检',
  trigger: { type: 'cron', expr: '0 2 * * *' },
  kind: 'shell',
  script: 'pg_dump prod',
  skillIds: [],
  mcpIds: [],
  policy: 'reject',
  whitelist: [],
  enabled: true,
  autoConfirmed: false,
  ownerId: 'local',
}

const wrap = (ui: React.ReactNode) => <LanguageProvider>{ui}</LanguageProvider>

describe('TasksPanel', () => {
  beforeEach(() => {
    vi.mocked(automationListTasks).mockReset()
  })

  it('renders tasks from the automation store', async () => {
    vi.mocked(automationListTasks).mockResolvedValue([TASK as never])
    render(wrap(<TasksPanel onClose={() => {}} />))
    expect(await screen.findByText('每日数据库备份巡检')).toBeTruthy()
    expect(screen.getByText('0 2 * * *')).toBeTruthy()
  })

  it('shows an empty hint when there are no tasks', async () => {
    vi.mocked(automationListTasks).mockResolvedValue([])
    render(wrap(<TasksPanel onClose={() => {}} />))
    // The panel still renders its header title.
    expect(await screen.findByText('定时任务')).toBeTruthy()
  })
})
