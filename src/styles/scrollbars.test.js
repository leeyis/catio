import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const tokensCss = readFileSync('src/styles/tokens.css', 'utf8')

describe('themed scrollbars', () => {
  it('colors every native scrollbar surface with theme tokens', () => {
    const themedColor = 'color-mix(in srgb, var(--text-faint) 45%, var(--surface-inset)) var(--surface-inset)'
    expect(tokensCss).toContain(`scrollbar-color: ${themedColor}`)
    expect(tokensCss).toContain('*::-webkit-scrollbar { width: 10px; height: 10px; background: var(--surface-inset); }')
    expect(tokensCss).toContain('*::-webkit-scrollbar-track { background: var(--surface-inset); }')
    expect(tokensCss).toContain('*::-webkit-scrollbar-button { width: 0; height: 0; background: var(--surface-inset); }')
    expect(tokensCss).toContain('*::-webkit-scrollbar-corner { background: var(--surface-inset); }')
    expect(tokensCss).toContain('.scrollon::-webkit-scrollbar-track { background: var(--surface-inset); }')
    expect(tokensCss).toContain('.scrollon::-webkit-scrollbar-corner { background: var(--surface-inset); }')
  })
})
