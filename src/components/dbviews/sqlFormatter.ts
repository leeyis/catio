/* SQL formatting follows the actual engine and non-sensitive editor preferences. */
import { format, type FormatOptionsWithLanguage } from 'sql-formatter'
import { DB_ENGINES } from '../../services/dbEngines'
import { DEFAULT_DATABASE_EDITOR_PREFERENCES, type DatabaseEditorPreferences } from '../../state/databaseEditorPreferences'
import { dialectFor } from './sqlDialect'

type SqlLanguage = FormatOptionsWithLanguage['language']
export function formatterLanguage(engine?: string): SqlLanguage {
  const id = engine?.toLowerCase()
  if (id === 'oracle' || id === 'oceanbase-oracle') return 'plsql'
  if (id === 'mariadb') return 'mariadb'
  if (id === 'rqlite') return 'sqlite'
  const family = DB_ENGINES.find(item => item.id === id)?.dbType ?? id
  switch (family) {
    case 'mysql': return 'mysql'
    case 'postgres': return 'postgresql'
    case 'sqlite': return 'sqlite'
    case 'duckdb': return 'duckdb'
    case 'clickhouse': return 'clickhouse'
    case 'sqlserver': return 'transactsql'
    default: return 'sql'
  }
}

/** Move only actual comma tokens, never commas in multiline strings, identifiers or comments.
 * Keep comment-adjacent commas unchanged rather than reattaching comments to different expressions. */
function leadingCommas(sql: string, engine?: string): string {
  const edits: { from: number; to: number; insert: string }[] = []
  const tree = dialectFor(engine).language.parser.parse(sql)
  tree.iterate({ enter(node) {
    if (node.name !== 'Punctuation' || sql.slice(node.from, node.to) !== ',') return
    const tail = /^(\r?\n)([ \t]*)(?=\S)/.exec(sql.slice(node.to))
    if (!tail || /^(--|\/\*|#)/.test(sql.slice(node.to + tail[0].length))) return
    edits.push({ from: node.from, to: node.to + tail[0].length, insert: tail[1] + tail[2] + ', ' })
  } })
  for (const edit of edits.reverse()) sql = sql.slice(0, edit.from) + edit.insert + sql.slice(edit.to)
  return sql
}
export function formatSql(sql: string, engine?: string, settings: Pick<DatabaseEditorPreferences, 'keywordCase' | 'commaPosition' | 'tabWidth'> = DEFAULT_DATABASE_EDITOR_PREFERENCES): string {
  if (!sql.trim() || sql.length > 1_000_000) return sql
  try {
    const result = format(sql, { language: formatterLanguage(engine), keywordCase: settings.keywordCase, tabWidth: settings.tabWidth })
    return settings.commaPosition === 'before' ? leadingCommas(result, engine) : result
  } catch {
    // Formatting must not destroy an unsupported or incomplete draft.
    return sql
  }
}
