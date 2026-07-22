import { describe, it, expect } from 'vitest'
import { buildAgentSystemPrompt } from './agentPrompt'

describe('buildAgentSystemPrompt', () => {
  it('shell mode → terminal/shell assistant naming the host', () => {
    const p = buildAgentSystemPrompt('shell', 'prod-web-01')
    expect(p).toContain('terminal/shell assistant')
    expect(p).toContain('prod-web-01')
    expect(p).toContain('untrusted data')
  })

  it.each(['ask', 'auto'] as const)('%s shell mode acts as a terminal operator loop', executionMode => {
    const p = buildAgentSystemPrompt('shell', 'prod-web-01', undefined, executionMode)
    expect(p).toContain('terminal operator')
    expect(p).toContain('exactly one single-line command')
    expect(p).toContain('docker logs --tail 200')
    expect(p).toContain('follow/watch commands are allowed')
    expect(p).toContain('tool loop continues until the task is complete')
    expect(p).toContain('Before receiving TERMINAL_RESULT')
  })

  it('allows a multi-line command block when the single-line limit is disabled', () => {
    const p = buildAgentSystemPrompt('shell', 'prod-web-01', undefined, 'ask', false)
    expect(p).toContain('A multi-line command block is allowed')
    expect(p).not.toContain('exactly one single-line command')
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
    // must NOT force a command for every input — conceptual questions get prose
    // (regression: agent replied "SCAN 0 MATCH * COUNT 1000" to "what can you do")
    expect(p).toMatch(/prose|actual question/i)
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
