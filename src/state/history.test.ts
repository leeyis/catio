import { describe, it, expect, beforeEach } from 'vitest'
import { appendHistory, loadHistory, clearHistory } from './history'
beforeEach(() => localStorage.clear())
describe('history store', () => {
  it('appends newest-first and assigns ids', () => {
    appendHistory({ kind: 'shell', target: 'h', text: 'cmd0', when: 'now', dur: '1ms', exitCode: 0 })
    appendHistory({ kind: 'shell', target: 'h', text: 'cmd1', when: 'now', dur: '2ms', exitCode: 1 })
    const l = loadHistory()
    expect(l).toHaveLength(2)
    expect(l[0].text).toBe('cmd1')      // newest first
    expect(l[0].id).toBeTruthy()
    expect(l[1].exitCode).toBe(0)
  })
  it('caps at 1000', () => {
    for (let i = 0; i < 1005; i++) appendHistory({ kind: 'shell', target: 'h', text: 'c'+i, when: 'now', dur: '1ms' })
    expect(loadHistory().length).toBe(1000)
    expect(loadHistory()[0].text).toBe('c1004')
  })
  it('clears', () => {
    appendHistory({ kind: 'shell', target: 'h', text: 'x', when: 'now', dur: '1ms' })
    clearHistory(); expect(loadHistory()).toHaveLength(0)
  })
})
