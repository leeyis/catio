import type { CompareDiff } from './compareTables'
import type { BinaryCell } from '../../services/types'
export type CompareChangeKind = 'inserts' | 'updates' | 'deletes'
export interface CompareChange {
  id: string; kind: CompareChangeKind; ordinal: number
  source?: unknown[]; target?: unknown[]
  sourceBinary: Set<number>; targetBinary: Set<number>; changedColumns: number[]
}
export function compareChanges(diff: CompareDiff): CompareChange[] {
  const binary = (kind: CompareChangeKind) => {
    const map = new Map<number, Set<number>>()
    for (const [row, col] of diff.binary?.[kind] ?? []) {
      if (!map.has(row)) map.set(row, new Set())
      map.get(row)!.add(col)
    }
    return (row: number) => map.get(row) ?? new Set<number>()
  }
  const insert = binary('inserts'), update = binary('updates'), remove = binary('deletes')
  return [
    ...diff.inserts.map((source, ordinal) => ({ id: `inserts:${ordinal}`, kind: 'inserts' as const, ordinal, source, sourceBinary: insert(ordinal), targetBinary: new Set<number>(), changedColumns: diff.colNames.map((_, i) => i) })),
    ...diff.updates.map((value, ordinal) => ({ id: `updates:${ordinal}`, kind: 'updates' as const, ordinal, source: value.src, target: value.tgt, sourceBinary: update(ordinal), targetBinary: new Set(value.targetBinary ?? []), changedColumns: value.changedColumns ?? [] })),
    ...diff.deletes.map((target, ordinal) => ({ id: `deletes:${ordinal}`, kind: 'deletes' as const, ordinal, target, sourceBinary: new Set<number>(), targetBinary: remove(ordinal), changedColumns: diff.colNames.map((_, i) => i) })),
  ]
}
/** Reindex the binary sidecar after selection. Never infer binary type from displayed text. */
export function selectedCompareDiff(diff: CompareDiff, selected: ReadonlySet<string>, allowDelete: boolean): CompareDiff {
  const indexes = (kind: CompareChangeKind, count: number) => Array.from({ length: count }, (_, i) => i).filter(i => selected.has(`${kind}:${i}`))
  const inserts = indexes('inserts', diff.inserts.length), updates = indexes('updates', diff.updates.length)
  const deletes = allowDelete ? indexes('deletes', diff.deletes.length) : []
  const cells = (kind: CompareChangeKind, indices: number[]): BinaryCell[] => {
    const positions = new Map(indices.map((old, next) => [old, next]))
    return (diff.binary?.[kind] ?? []).flatMap(([r, c]) => positions.has(r) ? [[positions.get(r)!, c] as BinaryCell] : [])
  }
  return { ...diff, inserts: inserts.map(i => diff.inserts[i]), updates: updates.map(i => diff.updates[i]), deletes: deletes.map(i => diff.deletes[i]),
    binary: { inserts: cells('inserts', inserts), updates: cells('updates', updates), deletes: cells('deletes', deletes) } }
}
