import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../state/LanguageContext'
import { DEFAULT_AGENT_CONFIG, getAgentConfig, setAgentConfig } from '../../state/agentConfig'
import { SettingsView } from './SettingsView'

describe('SettingsView Agent model', () => {
  beforeEach(() => {
    localStorage.clear()
    setAgentConfig(DEFAULT_AGENT_CONFIG)
  })

  it('accepts and persists a model name that is not returned by the provider', () => {
    const { container } = render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )
    const input = container.querySelector<HTMLInputElement>('input[list="agent-model-options"]')

    expect(input).not.toBeNull()
    fireEvent.change(input!, { target: { value: 'coding-plan-model' } })

    expect(getAgentConfig().model).toBe('coding-plan-model')
    expect(JSON.parse(localStorage.getItem('catio-agent-config') ?? '{}').model).toBe('coding-plan-model')
  })

  it('fills the provider endpoint and clears credentials when the provider changes', () => {
    setAgentConfig({ provider: 'openai', baseUrl: 'https://custom.example', apiKey: 'secret', model: 'old-model' })
    render(
      <LanguageProvider>
        <SettingsView theme="dawn" onTheme={vi.fn()} onClose={vi.fn()} initialSection="ai" />
      </LanguageProvider>,
    )
    fireEvent.change(screen.getByLabelText('模型提供商'), { target: { value: 'deepseek' } })
    expect(getAgentConfig()).toMatchObject({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: '',
    })
  })
})
