import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DEFAULT_AGENT_CONFIG, getAgentConfig, setAgentConfig } from '../../state/agentConfig'
import { SettingsView } from './SettingsView'

describe('SettingsView Agent model', () => {
  beforeEach(() => {
    localStorage.clear()
    setAgentConfig(DEFAULT_AGENT_CONFIG)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('accepts and persists a model name that is not returned by the provider', () => {
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )
    const input = screen.getByRole('combobox', { name: '模型' })

    fireEvent.change(input, { target: { value: 'coding-plan-model' } })

    expect(getAgentConfig().model).toBe('coding-plan-model')
    expect(JSON.parse(localStorage.getItem('catio-agent-config') ?? '{}').model).toBe('coding-plan-model')
  })

  it('configures command format and maximum rounds without duplicating execution mode', () => {
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )

    expect(screen.queryByRole('button', { name: '半自动' })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '单行命令限制' }))
    fireEvent.click(screen.getByRole('button', { name: '增加最大执行轮数' }))
    fireEvent.click(screen.getByRole('button', { name: '增加最大执行轮数' }))

    expect(getAgentConfig()).toMatchObject({ singleLineCommands: false, maxShellSteps: 10 })
    expect(JSON.parse(localStorage.getItem('catio-agent-config') ?? '{}')).toMatchObject({
      singleLineCommands: false,
      maxShellSteps: 10,
    })
  })

  it('fills the provider endpoint and clears credentials when the provider changes', () => {
    setAgentConfig({ provider: 'openai', baseUrl: 'https://custom.example', apiKey: 'secret', model: 'old-model' })
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    let providerList = screen.getByRole('listbox', { name: '模型提供商' })
    expect(within(providerList).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Ollama', 'DeepSeek', 'Zhipu', 'Kimi', 'OpenAI 兼容', 'Claude Code 兼容',
    ])
    expect(within(providerList).getByRole('option', { name: 'Kimi' })).toBeInTheDocument()
    fireEvent.click(within(providerList).getByRole('option', { name: 'OpenAI 兼容' }))
    expect(getAgentConfig().apiKey).toBe('secret')

    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    providerList = screen.getByRole('listbox', { name: '模型提供商' })
    fireEvent.click(within(providerList).getByRole('option', { name: 'Zhipu' }))
    expect(getAgentConfig()).toMatchObject({
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '',
      model: '',
    })
  })

  it('shows every fetched model without filtering the current value', async () => {
    setAgentConfig({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'model-a' })
    const fetchedModels = ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f']
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: fetchedModels.map(id => ({ id })) }),
    }))
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const modelList = await screen.findByRole('listbox', { name: '模型' })
    expect(within(modelList).getAllByRole('option')).toHaveLength(fetchedModels.length)

    fireEvent.click(within(modelList).getByRole('option', { name: 'model-f' }))
    expect(getAgentConfig().model).toBe('model-f')
  })

  it('reconciles a pending fetch with the latest manually entered model', async () => {
    setAgentConfig({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'model-a' })
    let resolveFetch!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve })))
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'model-b' } })
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ id: 'remote-model' }] }),
      })
    })

    const modelList = await screen.findByRole('listbox', { name: '模型' })
    expect(within(modelList).getByRole('option', { name: 'model-b' })).toBeInTheDocument()
    expect(within(modelList).queryByRole('option', { name: 'model-a' })).toBeNull()
    expect(getAgentConfig().model).toBe('model-b')
  })

  it('supports keyboard navigation and portals the provider list outside the scroller', () => {
    setAgentConfig({ provider: 'zhipu' })
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )
    const trigger = screen.getByRole('button', { name: '模型提供商' })
    vi.stubGlobal('innerHeight', 340)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 280, top: 280, left: 100, bottom: 316, right: 320, width: 220, height: 36, toJSON: () => ({}),
    } as DOMRect)

    fireEvent.click(trigger)
    let list = screen.getByRole('listbox', { name: '模型提供商' })
    expect(list.parentElement).toBe(document.body)
    expect(list.style.position).toBe('fixed')
    expect(list.style.bottom).not.toBe('')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(within(list).getByRole('option', { name: 'Zhipu' })).toHaveFocus()

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(within(list).getByRole('option', { name: 'Kimi' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'End' })
    expect(within(list).getByRole('option', { name: 'Claude Code 兼容' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'Home' })
    expect(within(list).getByRole('option', { name: 'Ollama' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(within(list).getByRole('option', { name: 'DeepSeek' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(getAgentConfig().provider).toBe('deepseek')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    list = screen.getByRole('listbox', { name: '模型提供商' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' })
    expect(getAgentConfig().provider).toBe('zhipu')

    fireEvent.click(trigger)
    list = screen.getByRole('listbox', { name: '模型提供商' })
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '模型提供商' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('supports keyboard navigation in the fetched model list', async () => {
    setAgentConfig({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'model-a' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] }),
    }))
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )

    const input = screen.getByRole('combobox', { name: '模型' })
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    let list = await screen.findByRole('listbox', { name: '模型' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(within(list).getByRole('option', { name: 'model-a' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'End' })
    expect(within(list).getByRole('option', { name: 'model-c' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(within(list).getByRole('option', { name: 'model-b' })).toHaveFocus()
    fireEvent.keyDown(list, { key: ' ' })
    expect(getAgentConfig().model).toBe('model-b')
    expect(input).toHaveAttribute('aria-expanded', 'false')

    const trigger = screen.getByRole('button', { name: '输入或选择模型...' })
    fireEvent.click(trigger)
    list = screen.getByRole('listbox', { name: '模型' })
    expect(within(list).getByRole('option', { name: 'model-b' })).toHaveFocus()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '模型' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('ignores a stale model response after the provider changes', async () => {
    let resolveFetch!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve })))
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '模型提供商' }))
    fireEvent.click(within(screen.getByRole('listbox', { name: '模型提供商' })).getByRole('option', { name: 'Zhipu' }))

    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ id: 'stale-deepseek-model' }] }),
      })
    })

    expect(getAgentConfig()).toMatchObject({ provider: 'zhipu', model: '' })
    expect(screen.queryByRole('option', { name: 'stale-deepseek-model' })).toBeNull()
  })
})
