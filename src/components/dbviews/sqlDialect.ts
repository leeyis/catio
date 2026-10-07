import { MSSQL, MariaSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL, SQLDialect } from '@codemirror/lang-sql'
import { DB_ENGINES } from '../../services/dbEngines'

// lang-sql disables backslash string escapes by default, unlike a default MySQL/MariaDB session.
// Per-session SQL_MODE changes (e.g. NO_BACKSLASH_ESCAPES/ANSI_QUOTES) remain a separate capability gate.
const mysqlDefault = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true })
const mariaDefault = SQLDialect.define({ ...MariaSQL.spec, backslashEscapes: true })
// SQLite accepts [quoted names] as well as backticks/double quotes. Without
// this, punctuation inside a valid bracketed name becomes a false syntax hint.
const sqlite = SQLDialect.define({ ...SQLite.spec, identifierQuotes: '`"[' })
// Oracle double quotes name objects, not strings. SQL Server #/## names are
// session/global temporary objects, not parser errors splitting a statement.
const oracle = SQLDialect.define({ ...PLSQL.spec, doubleQuotedStrings: false, identifierQuotes: '"' })
const sqlServer = SQLDialect.define({ ...MSSQL.spec, specialVar: '@#' })

/** Editor parsing only. Never use this fallback to authorize an operation or generate DDL. */
export function dialectFor(engine?: string): SQLDialect {
  const id = engine?.toLowerCase()
  if (id === 'oracle' || id === 'oceanbase-oracle') return oracle
  if (id === 'mariadb') return mariaDefault
  if (id === 'rqlite') return sqlite
  if (id === 'mssql') return sqlServer
  const family = DB_ENGINES.find(item => item.id === id)?.dbType ?? id
  switch (family) {
    case 'mysql': return mysqlDefault
    case 'sqlite': return sqlite
    case 'duckdb': case 'postgres': return PostgreSQL
    case 'sqlserver': return sqlServer
    case undefined: return PostgreSQL // Preserve the unconnected/demo editor's existing default.
    default: return StandardSQL // A generic JDBC/unknown engine is not silently PostgreSQL.
  }
}
