import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('Agent config persistence migration', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('migrates the legacy OpenAI fields and defaults execution to manual', async () => {
    localStorage.setItem('catio-agent-config', JSON.stringify({
      provider: 'openai',
      openaiBaseUrl: 'https://gateway.example/v1',
      openaiKey: 'legacy-key',
      model: 'legacy-model',
    }))
    const { getAgentConfig } = await import('./agentConfig')
    expect(getAgentConfig()).toEqual({
      provider: 'openai',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'legacy-key',
      anthropicAuthMode: 'api-key',
      model: 'legacy-model',
      executionMode: 'manual',
    })
  })

  it('keeps execution permission in memory for the current session only', async () => {
    const { getAgentConfig, setAgentConfig } = await import('./agentConfig')
    setAgentConfig({ executionMode: 'auto' })
    expect(getAgentConfig().executionMode).toBe('auto')
    expect(JSON.parse(localStorage.getItem('catio-agent-config') ?? '{}')).not.toHaveProperty('executionMode')

    vi.resetModules()
    const freshStore = await import('./agentConfig')
    expect(freshStore.getAgentConfig().executionMode).toBe('manual')
  })
})
