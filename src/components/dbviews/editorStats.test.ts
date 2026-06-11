import { describe, it, expect } from 'vitest'
import { editorStats } from './editorStats'

describe('editorStats', () => {
  it('reports a single line and zero-based char count for an empty doc', () => {
    expect(editorStats('', 0)).toEqual({ lines: 1, chars: 0, line: 1, col: 1 })
  })

  it('counts characters and keeps one line for single-line text', () => {
    expect(editorStats('select 1', 8)).toEqual({ lines: 1, chars: 8, line: 1, col: 9 })
  })

  it('counts multiple lines and locates the caret on the right line/col', () => {
    // "ab\ncd" — caret after 'c' (offset 4) is line 2, col 2
    expect(editorStats('ab\ncd', 4)).toEqual({ lines: 2, chars: 5, line: 2, col: 2 })
  })

  it('treats a trailing newline as opening a new (empty) last line', () => {
    expect(editorStats('a\n', 2)).toEqual({ lines: 2, chars: 2, line: 2, col: 1 })
  })

  it('clamps a caret offset past the end to the document end', () => {
    expect(editorStats('abc', 99)).toEqual({ lines: 1, chars: 3, line: 1, col: 4 })
  })
})
