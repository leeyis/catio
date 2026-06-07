import { describe, it, expect } from 'vitest'
import { nextTheme } from '../src/state/ThemeContext'
describe('theme', () => {
  it('cycles dawn -> amber -> grove -> dawn', () => {
    expect(nextTheme('dawn')).toBe('amber')
    expect(nextTheme('amber')).toBe('grove')
    expect(nextTheme('grove')).toBe('dawn')
  })
})
