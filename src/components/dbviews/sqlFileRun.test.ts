import { describe, it, expect } from 'vitest'
import {
  initialRunState,
  isTerminalStatus,
  reduceProgress,
  progressPercent,
  type SqlFileProgress,
} from './sqlFileRun'

function ev(p: Partial<SqlFileProgress>): SqlFileProgress {
  return {
    executionId: 'e1',
    status: 'running',
    statementIndex: 0,
    total: 0,
    successCount: 0,
    failureCount: 0,
    affectedRows: 0,
    elapsedMs: 0,
    statementSummary: '',
    error: null,
    ...p,
  }
}

describe('sqlFileRun pure logic', () => {
  it('initial state is empty and non-terminal', () => {
    const s = initialRunState()
    expect(s.successCount).toBe(0)
    expect(s.errors).toEqual([])
    expect(isTerminalStatus(s.status)).toBe(false)
  })

  it('isTerminalStatus marks done/error/cancelled', () => {
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('error')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('statementDone')).toBe(false)
  })

  it('running updates current statement and progress, taking latest counts', () => {
    let s = initialRunState()
    s = reduceProgress(s, ev({ status: 'running', statementIndex: 1, total: 4, statementSummary: 'SELECT 1' }))
    expect(s.currentStatement).toBe('SELECT 1')
    expect(s.statementIndex).toBe(1)
    expect(s.total).toBe(4)
    s = reduceProgress(s, ev({ status: 'statementDone', statementIndex: 1, total: 4, successCount: 1, affectedRows: 3 }))
    expect(s.successCount).toBe(1)
    expect(s.affectedRows).toBe(3)
    // statementDone (无 summary) 不抹掉「当前语句」展示
    expect(s.currentStatement).toBe('SELECT 1')
  })

  it('statementFailed accumulates error details with continue_on_error', () => {
    let s = initialRunState()
    s = reduceProgress(s, ev({ status: 'statementFailed', statementIndex: 2, total: 4, failureCount: 1, statementSummary: 'BAD 1', error: 'syntax error' }))
    s = reduceProgress(s, ev({ status: 'statementFailed', statementIndex: 3, total: 4, failureCount: 2, statementSummary: 'BAD 2', error: 'no such table' }))
    expect(s.failureCount).toBe(2)
    expect(s.errors).toEqual([
      { statementIndex: 2, summary: 'BAD 1', message: 'syntax error' },
      { statementIndex: 3, summary: 'BAD 2', message: 'no such table' },
    ])
  })

  it('reduceProgress does not mutate the input state', () => {
    const s = initialRunState()
    const next = reduceProgress(s, ev({ status: 'statementFailed', error: 'x', statementSummary: 's' }))
    expect(s.errors).toEqual([])
    expect(next.errors.length).toBe(1)
  })

  it('progressPercent clamps and handles zero total', () => {
    expect(progressPercent({ ...initialRunState(), total: 0, statementIndex: 0 })).toBe(0)
    expect(progressPercent({ ...initialRunState(), total: 4, statementIndex: 1 })).toBe(25)
    expect(progressPercent({ ...initialRunState(), total: 4, statementIndex: 4 })).toBe(100)
    expect(progressPercent({ ...initialRunState(), total: 4, statementIndex: 9 })).toBe(100)
  })
})
