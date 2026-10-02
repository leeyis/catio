import { binarySqlLiteral } from './binaryValue'
import type { BinaryCell } from '../../services/types'
/** SQL clipboard/export generation. Keep literal semantics aligned with db/dml.rs.
 * Never turn a selected-row copy into an unqualified whole-table UPDATE. */
import { type StructDialect } from './structureDdl'
export type { StructDialect }
export type CopyDialect = StructDialect | 'sqlserver' | 'sqlite' | 'duckdb' | 'clickhouse' | 'jdbc' | 'rqlite'

export function copyDialectFor(engine?: string): CopyDialect {
  return ['mysql', 'sqlserver', 'sqlite', 'duckdb', 'clickhouse', 'jdbc', 'rqlite'].includes(engine ?? '')
    ? engine as CopyDialect : 'postgres'
}
function quoteIdent(dialect: CopyDialect, name: string): string {
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (dialect === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}
function qualifiedTable(dialect: CopyDialect, schema: string | undefined, table: string): string {
  return schema ? `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, table)}` : quoteIdent(dialect, table)
}
function quoteString(value: string, dialect: CopyDialect): string {
  if ((dialect === 'mysql' || dialect === 'clickhouse') && /[\\\0]/.test(value)) {
    const hex = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
    return dialect === 'mysql' ? `CONVERT(X'${hex}' USING utf8mb4)` : `unhex('${hex}')`
  }
  const text = dialect === 'postgres' ? value.replace(/\\/g, '\\\\') : value
  const prefix = dialect === 'sqlserver' ? 'N' : dialect === 'postgres' && value.includes('\\') ? 'E' : ''
  return `${prefix}'${text.replace(/'/g, "''")}'`
}
export function sqlValue(value: unknown, dialect: CopyDialect = 'postgres', binary = false): string {
  if (binary) return binarySqlLiteral(value, dialect)
  if (value == null) return 'NULL'
  if (typeof value === 'boolean') return dialect === 'sqlserver' ? (value ? '1' : '0') : (value ? 'TRUE' : 'FALSE')
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quoteString(String(value), dialect)
  if (typeof value === 'object') {
    try { return quoteString(JSON.stringify(value), dialect) } catch { return quoteString(String(value), dialect) }
  }
  return quoteString(String(value), dialect)
}

export function buildInsertSql(rows: unknown[][], table: string, columns: string[], dialect: CopyDialect, schema?: string, binaryCells: BinaryCell[] = []): string {
  const binary = new Set(binaryCells.map(([r,c])=>`${r}:${c}`))
  if (!table || columns.length === 0) return ''
  const target = qualifiedTable(dialect, schema, table)
  const names = columns.map(column => quoteIdent(dialect, column)).join(', ')
  return rows.map((row,r) => `INSERT INTO ${target} (${names}) VALUES (${columns.map((_, index) => sqlValue(row[index], dialect, binary.has(`${r}:${index}`))).join(', ')});`).join('\n')
}
export type KeyOverride = { column: string; values: unknown[] }

export function buildUpdateSql(rows: unknown[][], table: string, columns: string[], dialect: CopyDialect,
  schema: string | undefined, pk: string[], keyOverride?: KeyOverride, binaryCells: BinaryCell[] = []): string {
  const binary = new Set(binaryCells.map(([r,c])=>`${r}:${c}`))
  if (!table || !rows.length) return ''
  const keyIndexes = pk.map(key => columns.indexOf(key))
  const hasKeys = pk.length > 0
    ? keyIndexes.every(index => index >= 0) && rows.every(row => keyIndexes.every(index => row[index] != null))
    : !!keyOverride && rows.every((_, index) => keyOverride.values[index] != null)
  if (!hasKeys) return ''
  const keySet = new Set(pk)
  const setColumns = pk.length ? columns.filter(column => !keySet.has(column)) : columns
  if (!setColumns.length) return ''
  const target = qualifiedTable(dialect, schema, table)
  return rows.map((row, index) => {
    const changes = setColumns.map(column => `${quoteIdent(dialect, column)} = ${sqlValue(row[columns.indexOf(column)], dialect, binary.has(`${index}:${columns.indexOf(column)}`))}`).join(', ')
    const where = pk.length
      ? pk.map((column, i) => `${quoteIdent(dialect, column)} = ${sqlValue(row[keyIndexes[i]], dialect, binary.has(`${index}:${keyIndexes[i]}`))}`).join(' AND ')
      : `${quoteIdent(dialect, keyOverride!.column)} = ${sqlValue(keyOverride!.values[index], dialect)}`
    return `UPDATE ${target} SET ${changes} WHERE ${where};`
  }).join('\n')
}
