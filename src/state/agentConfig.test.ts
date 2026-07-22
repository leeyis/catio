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
      anthropicAuthMode: 'auto',
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

  it('provides ready-to-use Zhipu and Kimi endpoints', async () => {
    const { DEFAULT_AGENT_CONFIG, MODEL_PROVIDER_PRESETS, MODEL_PROVIDER_ORDER } = await import('./agentConfig')

    expect(MODEL_PROVIDER_ORDER).toEqual(['ollama', 'deepseek', 'zhipu', 'kimi', 'openai', 'anthropic'])
    expect(DEFAULT_AGENT_CONFIG).toMatchObject({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com' })
    expect(MODEL_PROVIDER_PRESETS.zhipu).toEqual({
      protocol: 'openai',
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    })
    expect(MODEL_PROVIDER_PRESETS.kimi).toEqual({
      protocol: 'openai',
      defaultBaseUrl: 'https://api.moonshot.cn/v1',
    })
  })

  it('migrates a hidden legacy Anthropic auth override back to automatic detection', async () => {
    localStorage.setItem('catio-agent-config', JSON.stringify({
      provider: 'anthropic',
      baseUrl: 'https://proxy.example',
      apiKey: 'legacy-token',
      anthropicAuthMode: 'auth-token',
      model: 'claude',
    }))

    const { getAgentConfig } = await import('./agentConfig')
    expect(getAgentConfig().anthropicAuthMode).toBe('auto')
  })
})
