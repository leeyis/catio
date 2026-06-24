/**
 * DDL generation for the Structure tab's add/modify/drop-column flow.
 *
 * Reimplemented in TS from the dbx-core `table_structure_sql.rs` reference
 * (NOT copied) — same ALTER TABLE forms per dialect, scoped to the single-column
 * operations the workbench exposes. Postgres-first: defaults to ANSI double-quote
 * identifier quoting; MySQL/MariaDB use backticks.
 */

import type { TableStructure } from '../../services/types'

export type StructDialect = 'postgres' | 'mysql'

/** Map an engine string (Connection.engine / DbType) to a quoting dialect. Postgres-first. */
export function dialectFor(engine?: string): StructDialect {
  const e = (engine ?? '').toLowerCase()
  if (e.includes('mysql') || e.includes('maria') || e.includes('doris') || e.includes('starrocks')) return 'mysql'
  return 'postgres'
}

/**
 * 引擎是否支持 SQL/DDL 整库导出(生成 CREATE TABLE + INSERT 的 .sql)。
 *
 * 非关系型引擎(Redis / MongoDB / Elasticsearch)虽然 caps.sqlConsole=true(其控制台
 * 走 key glob / 命令 / DSL),但没有 SQL/DDL 语义 — 对它们生成 DDL/INSERT 的 .sql 会
 * 产生误导性内容。用显式 denylist 排除它们;其余关系型引擎(含 Oracle/达梦/TiDB 等开放集)
 * 默认放行。engine 缺省(mock/demo 路径)按关系型处理。
 */
export function supportsDdlExport(engine?: string): boolean {
  const e = (engine ?? '').toLowerCase()
  if (e.includes('redis') || e.includes('mongo') || e.includes('elastic')) return false
  return true
}

/** Quote an identifier for the dialect, escaping the quote char by doubling it. */
export function quoteIdent(dialect: StructDialect, name: string): string {
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/**
 * Schema-qualify + quote a table. When a schema is given, qualify with it for BOTH
 * dialects — for MySQL the "schema" is the database, and the workbench browses
 * across databases, so an unqualified ALTER would resolve against the connection's
 * current database (e.g. `esales`) instead of the table's own (`eastmoney`) and
 * fail with "table doesn't exist". Falls back to the bare table when no schema.
 */
export function qualifiedTable(dialect: StructDialect, schema: string | undefined, table: string): string {
  if (schema && schema.trim()) {
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
  /** Column comment. Empty string means "no comment". */
  comment?: string
}

/** ADD COLUMN. Returns a single statement (plus a Postgres COMMENT ON when a
 *  comment is set). Returns [] when name/type are blank. */
export function buildAddColumn(dialect: StructDialect, qualified: string, draft: ColumnDraft): string[] {
  const name = draft.name.trim()
  const type = draft.type.trim()
  if (!name || !type) return []
  const parts = [`ALTER TABLE ${qualified} ADD COLUMN ${quoteIdent(dialect, name)} ${type}`]
  if (!draft.nullable) parts.push('NOT NULL')
  const def = normalizeDefault(draft.default)
  if (def) parts.push(`DEFAULT ${formatDefault(type, def)}`)
  const comment = (draft.comment ?? '').trim()
  if (dialect === 'mysql') {
    // MySQL carries the comment inline in the column definition.
    if (comment) parts.push(`COMMENT ${quoteString(comment)}`)
    return [parts.join(' ') + ';']
  }
  // Postgres has no inline column comment — it's a separate COMMENT ON statement.
  const stmts = [parts.join(' ') + ';']
  if (comment) stmts.push(`COMMENT ON COLUMN ${qualified}.${quoteIdent(dialect, name)} IS ${quoteString(comment)};`)
  return stmts
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
  const nextComment = (next.comment ?? '').trim()
  const commentChanged = nextComment !== (original.comment ?? '').trim()

  if (dialect === 'mysql') {
    // RENAME alone is supported via RENAME COLUMN (MySQL 8); attribute changes use
    // MODIFY (same name) or CHANGE (rename + redefinition) carrying the full definition.
    // A comment change counts as an attribute change — and because MODIFY/CHANGE
    // rewrites the WHOLE definition, the (possibly unchanged) comment must always be
    // re-emitted or MySQL would silently drop it.
    const attrChanged = typeChanged || nullableChanged || defChanged || commentChanged
    if (renamed && !attrChanged) {
      stmts.push(`ALTER TABLE ${qualified} RENAME COLUMN ${quoteIdent(dialect, oldName)} TO ${quoteIdent(dialect, newName)};`)
      return stmts
    }
    if (attrChanged) {
      const def = normalizeDefault(next.default)
      const defs = [quoteIdent(dialect, newName), newType]
      if (!next.nullable) defs.push('NOT NULL')
      if (def) defs.push(`DEFAULT ${formatDefault(newType, def)}`)
      if (nextComment) defs.push(`COMMENT ${quoteString(nextComment)}`)
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
  // Postgres column comment is a standalone statement; clearing it emits IS NULL.
  if (commentChanged) {
    stmts.push(`COMMENT ON COLUMN ${qualified}.${current} IS ${nextComment ? quoteString(nextComment) : 'NULL'};`)
  }
  return stmts
}

/** DROP COLUMN. Returns a single statement. */
export function buildDropColumn(dialect: StructDialect, qualified: string, name: string): string[] {
  if (!name.trim()) return []
  return [`ALTER TABLE ${qualified} DROP COLUMN ${quoteIdent(dialect, name.trim())};`]
}

/**
 * Reconstruct a best-effort CREATE TABLE for the DDL tab (display/approximation,
 * not a faithful dump). Now includes column- and table-level comments:
 *   - MySQL: inline `comment '…'` on each column and a trailing `comment='…'`.
 *   - Postgres: separate `comment on table/column … is '…'` statements appended
 *     after the CREATE (Postgres has no inline comment syntax).
 * `qualified` is the (display) table reference; comments reuse it unquoted.
 */
export function buildCreateTableDDL(dialect: StructDialect, qualified: string, st: TableStructure): string {
  const cols = st.columns.map(c => {
    let line = `  ${c.name.padEnd(16)} ${c.type}${c.nullable ? '' : ' not null'}${c.default ? ' default ' + c.default : ''}${c.key === 'PK' ? ' primary key' : ''}`
    if (dialect === 'mysql' && c.comment) line += ` comment ${quoteString(c.comment)}`
    return line
  }).join(',\n')
  const fks = st.fks.map(fk => `  foreign key (${fk.col}) references ${fk.ref} on delete ${fk.onDelete}`).join(',\n')
  const tableComment = dialect === 'mysql' && st.comment ? ` comment=${quoteString(st.comment)}` : ''
  const indexes = st.indexes.filter(i => !i.name.endsWith('pkey'))
    .map(i => `create ${i.unique ? 'unique ' : ''}index ${i.name} on ${qualified} using ${i.method} (${i.cols});`)
    .join('\n')
  let ddl = `create table ${qualified} (\n${cols}${fks ? ',\n' + fks : ''}\n)${tableComment};\n\n${indexes}`
  if (dialect === 'postgres') {
    const comments: string[] = []
    if (st.comment) comments.push(`comment on table ${qualified} is ${quoteString(st.comment)};`)
    for (const c of st.columns) {
      if (c.comment) comments.push(`comment on column ${qualified}.${c.name} is ${quoteString(c.comment)};`)
    }
    if (comments.length) ddl += `${indexes ? '\n\n' : ''}${comments.join('\n')}`
  }
  return ddl
}
