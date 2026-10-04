import type { ErRelation } from '../../services/types'
import type { CompletionNamespace } from './sqlCompletionSchema'
import type { JoinTable } from './sqlJoinCompletion'
/** Catalog identity is a tuple, never a lowercased bare name or a split dotted string. */
export function buildJoinTables(namespaces: CompletionNamespace[], columns: (schema: string, table: string) => string[], relations: Record<string, ErRelation[]>): JoinTable[] {
  const catalog = new Map<string, JoinTable>()
  const ensure = (schema: string, name: string) => {
    const key = JSON.stringify([schema, name])
    let table = catalog.get(key)
    if (!table) { table = { schema, name, columns: columns(schema, name), foreignKeys: [] }; catalog.set(key, table) }
    return table
  }
  for (const ns of namespaces) {
    for (const table of [...ns.tables, ...ns.views]) ensure(ns.name, table.name)
    for (const row of relations[ns.name] ?? []) {
      // Old/unknown providers remain useful to ER displays, but cannot be silently
      // converted into single-column JOINs or assigned a guessed target namespace.
      if (row.fromSchema !== ns.name || row.toSchema === undefined || !row.constraintId || !row.ordinal || !row.columnCount || !row.fromCol || !row.toCol) continue
      const owner = ensure(row.fromSchema, row.from)
      ensure(row.toSchema, row.to)
      owner.foreignKeys.push({ column: row.fromCol, refTable: row.to, refSchema: row.toSchema, refColumn: row.toCol,
        constraintId: row.constraintId, ordinal: row.ordinal, columnCount: row.columnCount })
    }
  }
  return [...catalog.values()]
}
