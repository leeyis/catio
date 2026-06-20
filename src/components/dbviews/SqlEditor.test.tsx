import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'

// insertAtCursor is the seam history「执行」/「插入编辑器」 and snippet run go through.
// 执行 (newLine=true) must land the SQL on its OWN line — the bug report showed
// `…fact_sales_ordersSELECT …` concatenated on one line, which then errored.
// 插入编辑器 (newLine falsy) stays in place at the caret.
describe('SqlEditor.insertAtCursor', () => {
  it('run path (newLine) appends on a fresh line at the doc end — never concatenates', () => {
    const ref = createRef<SqlEditorHandle>()
    render(<SqlEditor ref={ref} code="SELECT * FROM fact_sales_orders" onChange={() => {}} />)
    expect(ref.current!.insertAtCursor('SELECT * FROM dim_customer', true))
      .toBe('SELECT * FROM fact_sales_orders\nSELECT * FROM dim_customer')
  })

  it('run path on an empty doc inserts with no leading blank line', () => {
    const ref = createRef<SqlEditorHandle>()
    render(<SqlEditor ref={ref} code="" onChange={() => {}} />)
    expect(ref.current!.insertAtCursor('SELECT 1', true)).toBe('SELECT 1')
  })

  it('run path does not double an existing trailing newline', () => {
    const ref = createRef<SqlEditorHandle>()
    render(<SqlEditor ref={ref} code={'SELECT 1\n'} onChange={() => {}} />)
    expect(ref.current!.insertAtCursor('SELECT 2', true)).toBe('SELECT 1\nSELECT 2')
  })

  it('insert path (no newLine) inserts at the caret in place', () => {
    const ref = createRef<SqlEditorHandle>()
    render(<SqlEditor ref={ref} code="SELECT 1" onChange={() => {}} />)
    // A fresh editor's caret sits at offset 0 → in-place insert lands there,
    // with no newline added (distinct from the run path's fresh-line append).
    expect(ref.current!.insertAtCursor('X')).toBe('XSELECT 1')
  })
})
