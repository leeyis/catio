import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))

describe('services/automation', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  it('listTasks returns mock sample off-Tauri (no backend)', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    const { automationListTasks } = await import('./automation')
    const list = await automationListTasks()
    expect(list.length).toBeGreaterThan(0)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('createTask forwards task payload', async () => {
    invokeMock.mockResolvedValue('task t1 saved')
    const { automationCreateTask } = await import('./automation')
    const task = {
      id: 't1',
      name: '备份',
      trigger: { type: 'cron' as const, expr: '0 2 * * *' },
      kind: 'shell' as const,
      script: 'pg_dump prod',
      skillIds: [],
      mcpIds: [],
      policy: 'reject' as const,
      whitelist: [],
      enabled: true,
      autoConfirmed: false,
    }
    await automationCreateTask(task)
    expect(invokeMock).toHaveBeenCalledWith('automation_create_task', { task })
  })

  it('setTaskEnabled forwards id + flag', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { automationSetTaskEnabled } = await import('./automation')
    await automationSetTaskEnabled('t1', false)
    expect(invokeMock).toHaveBeenCalledWith('automation_set_task_enabled', { id: 't1', enabled: false })
  })

  it('importSkill forwards body + scope', async () => {
    invokeMock.mockResolvedValue({ id: 's1', name: '巡检' })
    const { automationImportSkill } = await import('./automation')
    await automationImportSkill('{ "name": "巡检" }', 'global')
    expect(invokeMock).toHaveBeenCalledWith('automation_import_skill', {
      body: '{ "name": "巡检" }',
      scope: 'global',
      targetRef: undefined,
    })
  })

  it('installSkill forwards url + scope', async () => {
    invokeMock.mockResolvedValue({ id: 's2', name: 'x' })
    const { automationInstallSkill } = await import('./automation')
    await automationInstallSkill('https://skills.example/s.json', 'target', 'web-01')
    expect(invokeMock).toHaveBeenCalledWith('automation_install_skill', {
      url: 'https://skills.example/s.json',
      scope: 'target',
      targetRef: 'web-01',
    })
  })

  it('testMcp forwards the connection and returns tools', async () => {
    invokeMock.mockResolvedValue(['read_file', 'write_file'])
    const { automationTestMcp } = await import('./automation')
    const conn = {
      id: 'm1',
      name: 'Filesystem',
      transport: 'http' as const,
      url: 'http://127.0.0.1:8080/mcp',
      auth: 'bearer' as const,
      credential: 'sk-x',
      toolAllowlist: [],
      status: 'disconnected' as const,
      discoveredTools: [],
      ownerId: 'local',
    }
    const tools = await automationTestMcp(conn)
    expect(tools).toEqual(['read_file', 'write_file'])
    expect(invokeMock).toHaveBeenCalledWith('automation_test_mcp', { conn })
  })

  it('prompt history list + delete forward correctly', async () => {
    invokeMock.mockResolvedValue([{ id: 'h1' }])
    const { automationListPromptHistory, automationDeletePromptHistory } = await import('./automation')
    expect(await automationListPromptHistory()).toEqual([{ id: 'h1' }])
    invokeMock.mockResolvedValue(undefined)
    await automationDeletePromptHistory('h1')
    expect(invokeMock).toHaveBeenLastCalledWith('automation_delete_prompt_history', { id: 'h1' })
  })
})
