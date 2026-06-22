import { describe, it, expect } from 'vitest'
import { buildAgentSystemPrompt } from './agentPrompt'

describe('buildAgentSystemPrompt', () => {
  it('shell mode → terminal/shell assistant naming the host', () => {
    const p = buildAgentSystemPrompt('shell', 'prod-web-01')
    expect(p).toContain('terminal/shell assistant')
    expect(p).toContain('prod-web-01')
  })

  it('mongodb → instructs runnable mongo shell expressions, not a CLI wrapper', () => {
    const p = buildAgentSystemPrompt('sql', '253-Copilot', 'mongodb')
    expect(p).toContain('MongoDB')
    expect(p).toContain('db.users.find')
    // explicitly forbids the CLI form the model was producing
    expect(p.toLowerCase()).toContain('--eval')
    expect(p).toMatch(/never|不要|don't/i)
    expect(p).toContain('253-Copilot')
  })

  it('elasticsearch → REST + Query DSL', () => {
    const p = buildAgentSystemPrompt('sql', 'es-1', 'elasticsearch')
    expect(p).toContain('Elasticsearch')
    expect(p).toContain('Query DSL')
  })

  it('redis → raw Redis commands, not SQL, never suggests it lacks SQL', () => {
    const p = buildAgentSystemPrompt('sql', '192.168.10.20:6379', 'redis')
    expect(p).toContain('Redis')
    expect(p).toContain('HGETALL')
    expect(p).toContain('SCAN')
    // must steer away from SQL framing (the bug: agent said "Redis has no SQL")
    expect(p).toMatch(/never emit SELECT/i)
    // destructive commands are disabled in the console
    expect(p).toContain('FLUSHALL')
  })

  it('relational engine → that SQL dialect', () => {
    const p = buildAgentSystemPrompt('sql', 'pg', 'postgres')
    expect(p).toContain('postgres')
    expect(p).toMatch(/SQL/)
  })

  it('db mode with unknown engine → standard SQL', () => {
    const p = buildAgentSystemPrompt('sql', 'db', undefined)
    expect(p).toContain('standard SQL')
  })
})
