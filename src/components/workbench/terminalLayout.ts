/* Pure binary-tiling-tree logic for the terminal split view. A pane is a leaf; a split
 * is an interior node dividing its area 50/50 in a direction. Splitting one pane only
 * affects that pane's area (the rest of the layout is untouched), so e.g. splitting the
 * right pane of a left/right layout into top/bottom leaves the left pane alone.
 *
 * The component renders leaves as a FLAT, stably-keyed list positioned absolutely from
 * computeRects(); splitting/closing/swapping never reparents a leaf in the React tree, so
 * the underlying TerminalPane (and its live PTY session) is preserved. */

export type PaneNode =
  | { type: 'leaf'; id: string }
  | { type: 'split'; dir: 'row' | 'col'; a: PaneNode; b: PaneNode }

export interface Rect { left: number; top: number; width: number; height: number }

/** Replace leaf `id` with a split of [that leaf, a new leaf `newId`]. */
export function splitLeaf(node: PaneNode, id: string, dir: 'row' | 'col', newId: string): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== id) return node
    return { type: 'split', dir, a: { type: 'leaf', id }, b: { type: 'leaf', id: newId } }
  }
  return { ...node, a: splitLeaf(node.a, id, dir, newId), b: splitLeaf(node.b, id, dir, newId) }
}

/** Remove leaf `id`, promoting its sibling. Returns null if `node` itself is that leaf
 *  (the caller keeps the previous tree when the last pane can't be closed). */
export function closeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === id ? null : node
  const a = closeLeaf(node.a, id)
  const b = closeLeaf(node.b, id)
  if (a === null) return b
  if (b === null) return a
  return { ...node, a, b }
}

/** Swap the positions of two leaves (used by drag-to-reorder). */
export function swapLeaves(node: PaneNode, idA: string, idB: string): PaneNode {
  if (node.type === 'leaf') {
    if (node.id === idA) return { type: 'leaf', id: idB }
    if (node.id === idB) return { type: 'leaf', id: idA }
    return node
  }
  return { ...node, a: swapLeaves(node.a, idA, idB), b: swapLeaves(node.b, idA, idB) }
}

/** Leaf ids in traversal order. */
export function collectLeaves(node: PaneNode, out: string[] = []): string[] {
  if (node.type === 'leaf') { out.push(node.id); return out }
  collectLeaves(node.a, out)
  collectLeaves(node.b, out)
  return out
}

/** Compute each leaf's rectangle (percentages of the container) from the tree. */
export function computeRects(node: PaneNode, rect: Rect = { left: 0, top: 0, width: 100, height: 100 }, out: Map<string, Rect> = new Map()): Map<string, Rect> {
  if (node.type === 'leaf') { out.set(node.id, rect); return out }
  if (node.dir === 'row') {
    const w = rect.width / 2
    computeRects(node.a, { left: rect.left, top: rect.top, width: w, height: rect.height }, out)
    computeRects(node.b, { left: rect.left + w, top: rect.top, width: w, height: rect.height }, out)
  } else {
    const h = rect.height / 2
    computeRects(node.a, { left: rect.left, top: rect.top, width: rect.width, height: h }, out)
    computeRects(node.b, { left: rect.left, top: rect.top + h, width: rect.width, height: h }, out)
  }
  return out
}
