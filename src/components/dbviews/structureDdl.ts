/**
 * DDL generation for the Structure tab's add/modify/drop-column flow.
 *
 * Reimplemented in TS from the dbx-core `table_structure_sql.rs` reference
 * (NOT copied) — same ALTER TABLE forms per dialect, scoped to the single-column
 * operations the workbench exposes. Postgres-first: defaults to ANSI double-quote
 * identifier quoting; MySQL/MariaDB use backticks.
 */

export type StructDialect = 'postgres' | 'mysql'

/** Map an engine string (Connection.engine / DbType) to a quoting dialect. Postgres-first. */
export function dialectFor(engine?: string): StructDialect {
  const e = (engine ?? '').toLowerCase()
  if (e.includes('mysql') || e.includes('maria') || e.includes('doris') || e.includes('starrocks')) return 'mysql'
  return 'postgres'
}

/** Quote an identifier for the dialect, escaping the quote char by doubling it. */
export function quoteIdent(dialect: StructDialect, name: string): string {
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** Schema-qualify + quote a table. Postgres qualifies with the schema; MySQL uses the table alone. */
export function qualifiedTable(dialect: StructDialect, schema: string | undefined, table: string): string {
  if (dialect === 'postgres' && schema && schema.trim()) {
    return `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, table)}`
  }
  return quoteIdent(dialect, table)
}

/** Single-quote a string literal, escaping embedded quotes. */
function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** A `null`-ish default (empty / "null") means "no default". */
function normalizeDefault(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  return trimmed.toLowerCase() === 'null' ? '' : trimmed
}

/**
 * Render a DEFAULT value. A bare temporal/string literal (no parens, not an
 * expression) is quoted; everything else (numbers, function calls like now(),
 * keywords like CURRENT_TIMESTAMP) is passed through verbatim. The user can
 * always type an explicit `'literal'` to force quoting.
 */
function formatDefault(dataType: string, value: string): string {
  const v = value.trim()
  if (!v) return ''
  // Already a quoted literal, a number, or an expression → pass through.
  if (/^'.*'$/.test(v)) return v
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  if (v.includes('(') || v.includes(')')) return v // function call / expression
  const base = dataType.split('(')[0].trim().toLowerCase()
  const temporal = ['date', 'time', 'timestamp', 'timestamptz', 'datetime', 'timetz', 'interval', 'year']
  const isTemporal = temporal.some(t => base === t || base.startsWith(t + ' '))
  // A bare word for a temporal type is likely a keyword (e.g. CURRENT_TIMESTAMP) → pass through;
  // anything containing spaces/punctuation for a temporal type is a literal → quote it.
  if (isTemporal && /^[a-z_]+$/i.test(v)) return v
  if (isTemporal) return quoteString(v)
  // Non-temporal bare word: treat as a literal/keyword pass-through (covers true/false, enums typed bare).
  return v
}

export interface ColumnDraft {
  name: string
  type: string
  nullable: boolean
  /** Empty string / "null" means no default. */
  default: string
}

/** ADD COLUMN. Returns a single statement. Returns [] when name/type are blank. */
export function buildAddColumn(dialect: StructDialect, qualified: string, draft: ColumnDraft): string[] {
  const name = draft.name.trim()
  const type = draft.type.trim()
  if (!name || !type) return []
  const parts = [`ALTER TABLE ${qualified} ADD COLUMN ${quoteIdent(dialect, name)} ${type}`]
  if (!draft.nullable) parts.push('NOT NULL')
  const def = normalizeDefault(draft.default)
  if (def) parts.push(`DEFAULT ${formatDefault(type, def)}`)
  return [parts.join(' ') + ';']
}

/**
 * MODIFY COLUMN. Emits only the statements for fields that actually changed,
 * in the order rename → type → nullable → default.
 *
 * Postgres uses discrete ALTER COLUMN sub-statements; MySQL has no per-attribute
 * ALTER, so a non-rename change is expressed as a single MODIFY/CHANGE COLUMN
 * carrying the full (possibly-renamed) column definition.
 */
export function buildModifyColumn(
  dialect: StructDialect, qualified: string, original: ColumnDraft, next: ColumnDraft,
): string[] {
  const stmts: string[] = []
  const oldName = original.name.trim()
  const newName = next.name.trim()
  const newType = next.type.trim()
  if (!newName || !newType) return []

  const renamed = newName !== oldName
  const typeChanged = newType !== original.type.trim()
  const nullableChanged = next.nullable !== original.nullable
  const defChanged = normalizeDefault(next.default) !== normalizeDefault(original.default)

  if (dialect === 'mysql') {
    // RENAME alone is supported via RENAME COLUMN (MySQL 8); attribute changes use
    // MODIFY (same name) or CHANGE (rename + redefinition) carrying the full definition.
    const attrChanged = typeChanged || nullableChanged || defChanged
    if (renamed && !attrChanged) {
      stmts.push(`ALTER TABLE ${qualified} RENAME COLUMN ${quoteIdent(dialect, oldName)} TO ${quoteIdent(dialect, newName)};`)
      return stmts
    }
    if (attrChanged) {
      const def = normalizeDefault(next.default)
      const defs = [quoteIdent(dialect, newName), newType]
      if (!next.nullable) defs.push('NOT NULL')
      if (def) defs.push(`DEFAULT ${formatDefault(newType, def)}`)
      if (renamed) {
        stmts.push(`ALTER TABLE ${qualified} CHANGE COLUMN ${quoteIdent(dialect, oldName)} ${defs.join(' ')};`)
      } else {
        stmts.push(`ALTER TABLE ${qualified} MODIFY COLUMN ${defs.join(' ')};`)
      }
    }
    return stmts
  }

  // Postgres
  if (renamed) {
    stmts.push(`ALTER TABLE ${qualified} RENAME COLUMN ${quoteIdent(dialect, oldName)} TO ${quoteIdent(dialect, newName)};`)
  }
  const current = quoteIdent(dialect, newName) // after a rename subsequent stmts target the new name
  if (typeChanged) {
    stmts.push(`ALTER TABLE ${qualified} ALTER COLUMN ${current} TYPE ${newType};`)
  }
  if (nullableChanged) {
    const action = next.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'
    stmts.push(`ALTER TABLE ${qualified} ALTER COLUMN ${current} ${action};`)
  }
  if (defChanged) {
    const def = normalizeDefault(next.default)
    const action = def ? `SET DEFAULT ${formatDefault(newType, def)}` : 'DROP DEFAULT'
    stmts.push(`ALTER TABLE ${qualified} ALTER COLUMN ${current} ${action};`)
  }
  return stmts
}

/** DROP COLUMN. Returns a single statement. */
export function buildDropColumn(dialect: StructDialect, qualified: string, name: string): string[] {
  if (!name.trim()) return []
  return [`ALTER TABLE ${qualified} DROP COLUMN ${quoteIdent(dialect, name.trim())};`]
}
