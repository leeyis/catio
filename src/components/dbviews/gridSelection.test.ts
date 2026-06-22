import { describe, it, expect } from 'vitest'
import {
  normalizeRange,
  isCellInRange,
  reduceCellSelection,
  reduceRowSelection,
  cellsInRange,
  type GridSelection,
} from './gridSelection'

// 空选择：无任何单元格/行被选中。复用为各 reducer 的初始状态。
const empty: GridSelection = { anchor: null, focus: null, rows: new Set() }

describe('normalizeRange', () => {
  it('orders anchor/focus into min/max bounds regardless of drag direction', () => {
    expect(normalizeRange({ r: 3, c: 4 }, { r: 1, c: 2 })).toEqual({ r0: 1, r1: 3, c0: 2, c1: 4 })
    expect(normalizeRange({ r: 1, c: 2 }, { r: 3, c: 4 })).toEqual({ r0: 1, r1: 3, c0: 2, c1: 4 })
  })
})

describe('isCellInRange', () => {
  it('true only inside the inclusive rectangle', () => {
    const range = { r0: 1, r1: 3, c0: 1, c1: 2 }
    expect(isCellInRange(2, 1, range)).toBe(true)
    expect(isCellInRange(1, 1, range)).toBe(true)
    expect(isCellInRange(3, 2, range)).toBe(true)
    expect(isCellInRange(0, 1, range)).toBe(false)
    expect(isCellInRange(2, 3, range)).toBe(false)
  })
  it('null range contains nothing', () => {
    expect(isCellInRange(0, 0, null)).toBe(false)
  })
})

describe('reduceCellSelection (cell click → new selection)', () => {
  it('plain click selects a single cell and clears row selection', () => {
    const prev: GridSelection = { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 }, rows: new Set([5]) }
    const next = reduceCellSelection(prev, 2, 3, {})
    expect(next.anchor).toEqual({ r: 2, c: 3 })
    expect(next.focus).toEqual({ r: 2, c: 3 })
    expect(next.rows.size).toBe(0)
  })

  it('shift-click extends the range from the existing anchor (keeps anchor, moves focus)', () => {
    const prev: GridSelection = { anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 }, rows: new Set() }
    const next = reduceCellSelection(prev, 3, 4, { shift: true })
    expect(next.anchor).toEqual({ r: 1, c: 1 })
    expect(next.focus).toEqual({ r: 3, c: 4 })
  })

  it('shift-click with no prior anchor falls back to a single-cell selection', () => {
    const next = reduceCellSelection(empty, 2, 2, { shift: true })
    expect(next.anchor).toEqual({ r: 2, c: 2 })
    expect(next.focus).toEqual({ r: 2, c: 2 })
  })

  it('ctrl-click on a cell collapses to that single cell (no multi-rect support)', () => {
    const prev: GridSelection = { anchor: { r: 0, c: 0 }, focus: { r: 2, c: 2 }, rows: new Set() }
    const next = reduceCellSelection(prev, 5, 5, { ctrl: true })
    expect(next.anchor).toEqual({ r: 5, c: 5 })
    expect(next.focus).toEqual({ r: 5, c: 5 })
  })
})

describe('reduceRowSelection (row-header click → new selection)', () => {
  it('plain click selects just that row and clears any cell range', () => {
    const prev: GridSelection = { anchor: { r: 0, c: 0 }, focus: { r: 2, c: 2 }, rows: new Set() }
    const next = reduceRowSelection(prev, 4, { lastRow: null }, {})
    expect([...next.rows]).toEqual([4])
    expect(next.anchor).toBeNull()
    expect(next.focus).toBeNull()
  })

  it('ctrl-click toggles a row in/out of the set', () => {
    const prev: GridSelection = { ...empty, rows: new Set([1, 2]) }
    const added = reduceRowSelection(prev, 3, { lastRow: 2 }, { ctrl: true })
    expect([...added.rows].sort((a, b) => a - b)).toEqual([1, 2, 3])
    const removed = reduceRowSelection(added, 2, { lastRow: 3 }, { ctrl: true })
    expect([...removed.rows].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('shift-click selects the inclusive range from the last clicked row', () => {
    const prev: GridSelection = { ...empty, rows: new Set([2]) }
    const next = reduceRowSelection(prev, 5, { lastRow: 2 }, { shift: true })
    expect([...next.rows].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('shift-click backwards still produces the inclusive range', () => {
    const prev: GridSelection = { ...empty, rows: new Set([5]) }
    const next = reduceRowSelection(prev, 2, { lastRow: 5 }, { shift: true })
    expect([...next.rows].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })
})

describe('cellsInRange (enumerate r/c coordinates of a selection)', () => {
  it('lists every cell of the normalized rectangle', () => {
    const sel: GridSelection = { anchor: { r: 1, c: 1 }, focus: { r: 2, c: 2 }, rows: new Set() }
    expect(cellsInRange(sel)).toEqual([
      { r: 1, c: 1 }, { r: 1, c: 2 },
      { r: 2, c: 1 }, { r: 2, c: 2 },
    ])
  })
  it('empty selection yields no cells', () => {
    expect(cellsInRange(empty)).toEqual([])
  })
})
