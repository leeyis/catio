import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isSensitiveCommand, type RiskCode } from './sensitiveCommands'

interface PolicyCase {
  command: string
  sensitive: boolean
  reasons: RiskCode[]
}

const cases = JSON.parse(
  readFileSync(resolve('src-tauri/tests/fixtures/agent/policy_commands.json'), 'utf8'),
) as PolicyCase[]

describe('sensitive command classifier parity fixture', () => {
  it('classifies every shared fixture case identically', () => {
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const result = isSensitiveCommand(c.command)
      expect(result.sensitive).toBe(c.sensitive)
      expect(result.reasons).toEqual(c.reasons)
    }
  })
})
