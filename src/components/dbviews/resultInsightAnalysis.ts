import type { QueryResult } from '../../services/types'
export const INSIGHT_ROW_LIMIT = 2000
export const INSIGHT_COLUMN_LIMIT = 100
export interface ResultProfile { name: string; index: number; type: string; nulls: number; empty: number; binary: number; numbers: number; min: number | null; max: number | null }
export function profileResult(result: Pick<QueryResult, 'columns' | 'rows' | 'binaryCells'>): ResultProfile[] {
  const rows = result.rows.slice(0, INSIGHT_ROW_LIMIT)
  const binary = new Set((result.binaryCells ?? []).filter(([r,c]) => r < rows.length && c < INSIGHT_COLUMN_LIMIT).map(([r,c]) => `${r}:${c}`))
  return result.columns.slice(0, INSIGHT_COLUMN_LIMIT).map((col, index) => {
    const out: ResultProfile = { name:col.name, index, type:col.type, nulls:0, empty:0, binary:0, numbers:0, min:null, max:null }
    rows.forEach((row, r) => {
      const value = row[index]
      if (value == null) out.nulls++
      else if (binary.has(`${r}:${index}`)) out.binary++
      else if (value === '') out.empty++
      else if (typeof value === 'number' && Number.isFinite(value)) {
        out.numbers++; out.min = out.min === null ? value : Math.min(out.min, value); out.max = out.max === null ? value : Math.max(out.max, value)
      }
    })
    return out
  })
}
export function resultFrequencies(result: Pick<QueryResult, 'rows' | 'binaryCells'>, column: number) {
  const binary = new Set((result.binaryCells ?? []).filter(([,c]) => c === column).map(([r]) => r))
  const groups = new Map<string, number>()
  let skipped = 0
  result.rows.slice(0, INSIGHT_ROW_LIMIT).forEach((row, index) => {
    const value = row[column]
    if (binary.has(index) || value != null && (typeof value === 'object' || typeof value === 'string' && value.length > 256 || typeof value === 'number' && !Number.isFinite(value))) { skipped++; return }
    const label = value == null ? 'NULL' : typeof value === 'string' ? JSON.stringify(value) : String(value)
    groups.set(label, (groups.get(label) ?? 0) + 1)
  })
  const sorted = [...groups].map(([label,count]) => ({label,count})).sort((a,b) => b.count - a.count || a.label.localeCompare(b.label))
  return { items:sorted.slice(0,12), other:sorted.slice(12).reduce((sum,item) => sum + item.count, 0), skipped }
}
