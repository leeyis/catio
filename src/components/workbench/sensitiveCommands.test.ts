import { describe, expect, it } from 'vitest'
import { isSensitiveCommand, type RiskCode } from './sensitiveCommands'
import policyFixture from '../../../src-tauri/tests/fixtures/agent/policy_commands.json?raw'

interface PolicyCase {
  command: string
  sensitive: boolean
  reasons: RiskCode[]
}

const cases = JSON.parse(policyFixture) as PolicyCase[]

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
