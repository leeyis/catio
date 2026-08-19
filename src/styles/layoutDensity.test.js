import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const tokensCss = readFileSync('src/styles/tokens.css', 'utf8')

describe('compact workspace CSS', () => {
  let style

  beforeAll(() => {
    style = document.createElement('style')
    style.textContent = tokensCss
    document.head.appendChild(style)
  })

  afterAll(() => style.remove())

  it('keeps the workspace shell tight and its ordinary panels nearly square', () => {
    const shell = document.createElement('div')
    const panel = document.createElement('div')
    shell.className = 'body'
    panel.className = 'card-surface'
    shell.appendChild(panel)
    document.body.appendChild(shell)

    expect(getComputedStyle(shell).padding).toBe('8px')
    expect(getComputedStyle(shell).gap).toBe('8px')
    expect(getComputedStyle(panel).borderRadius).toBe('6px')

    shell.remove()
  })
})
