/**
 * Render a single table/collection/index's structure into a context block for
 * the Agent panel's "@ 选表" feature. The backend's `tableStructure()` already
 * normalizes every engine into a uniform `{ columns, indexes, fks }` shape
 * (relational metadata, Mongo sampled-field inference, ES `_mapping`), so this
 * is a pure renderer: same input shape, engine-aware output.
 *
 *  - relational → an executable-looking `CREATE TABLE` (indexes/FKs as comments)
 *  - mongodb    → a collection field list (schema inferred from sampled docs)
 *  - elasticsearch → an index mapping field list
 */
import type { TableStructure } from '../../services/types'
import { dialectFor, quoteIdent, qualifiedTable } from './structureDdl'

type EngineFamily = 'mongo' | 'es' | 'relational'

/** Classify an engine string into a rendering family. Unknown → relational. */
function engineFamily(engine?: string): EngineFamily {
  const e = (engine ?? '').toLowerCase()
  if (e.includes('mongo')) return 'mongo'
  if (e.includes('elastic') || e === 'es') return 'es'
  return 'relational'
}

/** relational: CREATE TABLE with NOT NULL / DEFAULT, PRIMARY KEY, index/FK comments. */
function renderRelational(engine: string | undefined, schema: string, table: string, struct: TableStructure): string {
  const dialect = dialectFor(engine)
  const qname = qualifiedTable(dialect, schema, table)
  const lines = struct.columns.map(c => {
    const parts = [`  ${quoteIdent(dialect, c.name)} ${c.type}`]
    if (!c.nullable) parts.push('NOT NULL')
    if (c.default != null && c.default !== '') parts.push(`DEFAULT ${c.default}`)
    return parts.join(' ')
  })
  const pkCols = struct.columns.filter(c => c.key === 'PK').map(c => quoteIdent(dialect, c.name))
  if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)
  let out = `CREATE TABLE ${qname} (\n${lines.join(',\n')}\n);`
  for (const idx of struct.indexes) {
    out += `\n-- INDEX ${idx.name} (${idx.cols})${idx.unique ? ' UNIQUE' : ''}`
  }
  for (const fk of struct.fks) {
    out += `\n-- FOREIGN KEY (${fk.col}) REFERENCES ${fk.ref}`
  }
  return out
}

/** mongo/es: a commented field list (no DDL concept exists for these engines). */
function renderFieldList(header: string, struct: TableStructure): string {
  if (struct.columns.length === 0) {
    return `${header}\n// (no inferable fields)`
  }
  const fields = struct.columns.map(c => {
    const pk = c.key === 'PK' ? ' (primary key)' : ''
    return `//   ${c.name}: ${c.type}${pk}`
  })
  let out = `${header}\n// fields:\n${fields.join('\n')}`
  if (struct.indexes.length) {
    const idx = struct.indexes.map(i => `${i.name} (${i.cols})${i.unique ? ' [unique]' : ''}`)
    out += `\n// indexes: ${idx.join(', ')}`
  }
  return out
}

export function buildTableContext(
  engine: string | undefined, schema: string, table: string, struct: TableStructure,
): string {
  switch (engineFamily(engine)) {
    case 'mongo':
      return renderFieldList(`// MongoDB collection "${table}" (schema inferred from sampled documents)`, struct)
    case 'es':
      return renderFieldList(`// Elasticsearch index "${table}" mapping`, struct)
    default:
      return renderRelational(engine, schema, table, struct)
  }
}
