import { MSSQL, MariaSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect } from '@codemirror/lang-sql'
import { DB_ENGINES } from '../../services/dbEngines'

/** Editor parsing only. Never use this fallback to authorize an operation or generate DDL. */
export function dialectFor(engine?: string): SQLDialect {
  const id = engine?.toLowerCase()
  if (id === 'oracle' || id === 'oceanbase-oracle') return PLSQL
  if (id === 'mariadb') return MariaSQL
  if (id === 'rqlite') return SQLite
  if (id === 'mssql') return MSSQL
  const family = DB_ENGINES.find(item => item.id === id)?.dbType ?? id
  switch (family) {
    case 'mysql': return MySQL
    case 'sqlite': return SQLite
    case 'duckdb': case 'postgres': return PostgreSQL
    case 'sqlserver': return MSSQL
    case undefined: return PostgreSQL // Preserve the unconnected/demo editor's existing default.
    default: return StandardSQL // A generic JDBC/unknown engine is not silently PostgreSQL.
  }
}
