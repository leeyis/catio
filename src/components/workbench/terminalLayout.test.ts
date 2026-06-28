import { describe, it, expect } from 'vitest'
import { splitLeaf, closeLeaf, swapLeaves, collectLeaves, computeRects, type PaneNode } from './terminalLayout'

const leaf = (id: string): PaneNode => ({ type: 'leaf', id })

describe('terminalLayout', () => {
  it('splits a single pane into two halves', () => {
    const root = splitLeaf(leaf('A'), 'A', 'row', 'B')
    expect(collectLeaves(root)).toEqual(['A', 'B'])
    const r = computeRects(root)
    expect(r.get('A')).toEqual({ left: 0, top: 0, width: 50, height: 100 })
    expect(r.get('B')).toEqual({ left: 50, top: 0, width: 50, height: 100 })
  })

  it('nested split only affects the targeted pane (left stays put)', () => {
    // left/right: A | B, then split B top/bottom → A unchanged, B becomes B/C stacked
    let root = splitLeaf(leaf('A'), 'A', 'row', 'B')
    root = splitLeaf(root, 'B', 'col', 'C')
    expect(collectLeaves(root)).toEqual(['A', 'B', 'C'])
    const r = computeRects(root)
    expect(r.get('A')).toEqual({ left: 0, top: 0, width: 50, height: 100 })          // unchanged full-height left
    expect(r.get('B')).toEqual({ left: 50, top: 0, width: 50, height: 50 })          // right-top quarter
    expect(r.get('C')).toEqual({ left: 50, top: 50, width: 50, height: 50 })         // right-bottom quarter
  })

  it('closing a pane promotes its sibling to the parent area', () => {
    let root = splitLeaf(leaf('A'), 'A', 'row', 'B')
    root = splitLeaf(root, 'B', 'col', 'C')
    const next = closeLeaf(root, 'C')!
    expect(collectLeaves(next)).toEqual(['A', 'B'])
    const r = computeRects(next)
    expect(r.get('B')).toEqual({ left: 50, top: 0, width: 50, height: 100 }) // B reclaims the full right half
  })

  it('returns null when closing the only pane', () => {
    expect(closeLeaf(leaf('A'), 'A')).toBeNull()
  })

  it('swaps two leaf positions without changing structure', () => {
    let root = splitLeaf(leaf('A'), 'A', 'row', 'B')
    const before = computeRects(root)
    root = swapLeaves(root, 'A', 'B')
    const after = computeRects(root)
    expect(after.get('A')).toEqual(before.get('B'))
    expect(after.get('B')).toEqual(before.get('A'))
    expect(collectLeaves(root).sort()).toEqual(['A', 'B'])
  })
})
