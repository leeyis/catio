import type { ResultColumn } from '../../services/types'
export interface GridColumn extends ResultColumn { sourceName?: string }

/** SQL JOINs and expressions may return repeated/empty labels. Use stable visible
 * aliases, not a name→index map that silently substitutes the last matching value.
 * Reserve all original names first so a generated alias cannot shadow a real one.
 */
export function uniqueGridColumns(columns: ResultColumn[]): GridColumn[] {
  const used = new Set(columns.map(column => column.name))
  const seen = new Set<string>()
  return columns.map((column, index) => {
    if (column.name && !seen.has(column.name)) { seen.add(column.name); return column }
    const base = column.name || `column_${index + 1}`
    let name = base, suffix = 2
    while (used.has(name)) name = `${base} (${suffix++})`
    used.add(name); seen.add(name)
    return { ...column, name, sourceName: column.name }
  })
}
